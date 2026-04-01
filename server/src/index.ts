import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import restaurantsRouter from './routes/restaurants.js';
import menusRouter from './routes/menus.js';
import compareRouter, { setAdapters } from './routes/compare.js';
import ordersRouter from './routes/orders.js';
import savingsRouter from './routes/savings.js';
import { scheduleDailySync } from './services/sync.js';
import type { PlatformAdapter } from './adapters/types.js';
import { SeamlessAdapter } from './adapters/seamless/adapter.js';
import { DoorDashAdapter } from './adapters/doordash/adapter.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
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

// Platform adapter registry
const adapters = new Map<string, PlatformAdapter>();

async function start(): Promise<void> {
  // Initialize platform adapters
  // DoorDash: uses real Chrome via CDP. Requires OTP login on first run.
  if (process.env.DOORDASH_EMAIL) {
    try {
      const doordash = new DoorDashAdapter();
      await doordash.initialize({ email: process.env.DOORDASH_EMAIL });
      adapters.set('doordash', doordash);
      console.log('[Kortana] DoorDash adapter registered.');
    } catch (err) {
      console.error('[Kortana] DoorDash adapter failed to initialize:', err);
      console.log('[Kortana] Continuing without DoorDash live adapter (will use DB estimates).');
    }
  } else {
    console.log('[Kortana] DOORDASH_EMAIL not set — skipping DoorDash adapter.');
  }

  // Seamless: email/password auth
  if (process.env.SEAMLESS_EMAIL) {
    try {
      const seamless = new SeamlessAdapter();
      await seamless.initialize({
        email: process.env.SEAMLESS_EMAIL,
        password: process.env.SEAMLESS_PASSWORD,
      });
      adapters.set('seamless', seamless);
      console.log('[Kortana] Seamless adapter registered.');
    } catch (err) {
      console.error('[Kortana] Seamless adapter failed to initialize:', err);
      console.log('[Kortana] Continuing without Seamless live adapter (will use DB estimates).');
    }
  } else {
    console.log('[Kortana] SEAMLESS_EMAIL not set — skipping Seamless adapter.');
  }

  // Inject adapters into comparison route
  setAdapters(adapters);

  // Schedule daily sync
  scheduleDailySync(adapters);

  app.listen(PORT, () => {
    console.log(`[Kortana] Server running on http://localhost:${PORT}`);
    console.log(`[Kortana] Health check: http://localhost:${PORT}/api/health`);
  });
}

start().catch((err) => {
  console.error('[Kortana] Failed to start:', err);
  process.exit(1);
});
