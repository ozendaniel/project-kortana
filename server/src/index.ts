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
  // TODO: Initialize platform adapters
  // const doordash = new DoorDashAdapter();
  // await doordash.initialize({ email: process.env.DOORDASH_EMAIL! });
  // adapters.set('doordash', doordash);
  //
  // const seamless = new SeamlessAdapter();
  // await seamless.initialize({ email: process.env.SEAMLESS_EMAIL!, password: process.env.SEAMLESS_PASSWORD });
  // adapters.set('seamless', seamless);

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
