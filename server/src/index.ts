import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root (works from both dev and production paths)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import restaurantsRouter from './routes/restaurants.js';
import menusRouter from './routes/menus.js';
import compareRouter, { setAdapters } from './routes/compare.js';
import ordersRouter from './routes/orders.js';
import savingsRouter from './routes/savings.js';
import authRouter, { setAuthManager } from './routes/auth.js';
import menuItemsRouter from './routes/menu-items.js';
import { scheduleDailySync } from './services/sync.js';
import { AuthManager } from './services/auth-manager.js';
import { setupWebSocket } from './services/ws-server.js';
import type { PlatformAdapter } from './adapters/types.js';
import { SeamlessAdapter } from './adapters/seamless/adapter.js';
import { DoorDashAdapter } from './adapters/doordash/adapter.js';
import { getActiveLock } from './utils/process-lock.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  } : false,
}));
if (!isProd) {
  app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
}
app.use(express.json());

// Routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/restaurants', restaurantsRouter);
app.use('/api/menus', menusRouter);
app.use('/api/compare', compareRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/savings', savingsRouter);
app.use('/api/auth', authRouter);
app.use('/api/menu-items', menuItemsRouter);

// In production, serve built client files from the same Express server
if (isProd) {
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
}

// Platform adapter registry
const adapters = new Map<string, PlatformAdapter>();
const authManager = new AuthManager();
setAuthManager(authManager);

// SPA fallback: non-API routes serve index.html (client-side routing)
if (isProd) {
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Start HTTP server and WebSocket immediately — adapters initialize in background
const server = app.listen(PORT, () => {
  console.log(`[Kortana] Server running on http://localhost:${PORT}`);
  console.log(`[Kortana] Health check: http://localhost:${PORT}/api/health`);
});

setupWebSocket(server, authManager);

// Initialize platform adapters in background (don't block server startup)
async function initAdapters(): Promise<void> {
  if (process.env.DOORDASH_EMAIL) {
    // Skip if a populate script is actively holding a lock. Stale locks
    // (owning PID is dead) are cleaned up automatically by getActiveLock.
    const ddLock = getActiveLock('doordash-populate');
    if (ddLock) {
      console.log(`[Kortana] DoorDash populate script running (pid ${ddLock.pid}, started ${ddLock.startedAt}) — skipping adapter to avoid interference.`);
    } else {
      try {
        const doordash = new DoorDashAdapter();
        await doordash.initialize({ email: process.env.DOORDASH_EMAIL });
        adapters.set('doordash', doordash);
        authManager.registerPlatform('doordash', doordash.getBrowser(), doordash.getStatus(), async () => {
          doordash.setStatus('authenticated');
        });
        doordash.onAuthExpired = () => authManager.markExpired('doordash');
        console.log(`[Kortana] DoorDash adapter registered (${doordash.getStatus()}).`);
      } catch (err) {
        console.error('[Kortana] DoorDash adapter failed to initialize:', err);
        console.log('[Kortana] Continuing without DoorDash live adapter (will use DB estimates).');
      }
    }
  } else {
    console.log('[Kortana] DOORDASH_EMAIL not set — skipping DoorDash adapter.');
  }

  if (process.env.SEAMLESS_EMAIL) {
    // Skip if a Seamless populate script is actively holding a lock.
    // Stale Chrome on port 9223 no longer blocks init — only an active populate does.
    const slLock = getActiveLock('seamless-populate');
    if (slLock) {
      console.log(`[Kortana] Seamless populate script running (pid ${slLock.pid}, started ${slLock.startedAt}) — skipping adapter to avoid interference.`);
    } else {
      try {
        const seamless = new SeamlessAdapter();
        await seamless.initialize({
          email: process.env.SEAMLESS_EMAIL,
          password: process.env.SEAMLESS_PASSWORD,
        });
        adapters.set('seamless', seamless);
        authManager.registerPlatform('seamless', seamless.getBrowser(), seamless.getStatus(), async () => {
          seamless.setStatus('authenticated');
          await seamless.refreshTokens();
        });
        seamless.onAuthExpired = () => authManager.markExpired('seamless');
        console.log(`[Kortana] Seamless adapter registered (${seamless.getStatus()}).`);
      } catch (err) {
        console.error('[Kortana] Seamless adapter failed to initialize:', err);
        console.log('[Kortana] Continuing without Seamless live adapter (will use DB estimates).');
      }
    }
  } else {
    console.log('[Kortana] SEAMLESS_EMAIL not set — skipping Seamless adapter.');
  }

  // Inject adapters into comparison route
  setAdapters(adapters);

  // Schedule daily sync
  scheduleDailySync(adapters);

  // Start session monitoring
  authManager.startSessionMonitor();
}

initAdapters().catch((err) => {
  console.error('[Kortana] Adapter initialization failed:', err);
});
