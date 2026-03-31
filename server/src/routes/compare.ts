import { Router, type Request, type Response } from 'express';
import { compareOrder } from '../services/comparison.js';
import type { PlatformAdapter } from '../adapters/types.js';

// Adapters are injected when the router is mounted
let adapters: Map<string, PlatformAdapter>;

export function setAdapters(a: Map<string, PlatformAdapter>): void {
  adapters = a;
}

const router = Router();

/**
 * POST /api/compare
 * Body: { restaurantId, address: { lat, lng, address }, items: [{ itemId, quantity }] }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { restaurantId, address, items } = req.body;

    if (!restaurantId || !address || !items || !Array.isArray(items)) {
      return res.status(400).json({
        error: 'Required: restaurantId, address (lat/lng/address), items array',
      });
    }

    // Pass adapters if available, otherwise comparison falls back to DB-based pricing
    const result = await compareOrder(restaurantId, items, address, adapters || undefined);

    res.json({ comparison: result });
  } catch (err) {
    console.error('[Route] /compare error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
