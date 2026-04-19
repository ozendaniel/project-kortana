import { Router, type Request, type Response } from 'express';
import { compareOrder, clearFeeCache } from '../services/comparison.js';
import type { PlatformAdapter, Platform } from '../adapters/types.js';
import type { AuthManager } from '../services/auth-manager.js';
import { getActiveLock } from '../utils/process-lock.js';

export interface PreflightAddress {
  id: string;
  address: string;
  lat: number;
  lng: number;
}

export interface PreflightPlatformStatus {
  ready: boolean;
  reason?: 'adapter_unavailable' | 'session_expired';
  accountAddresses?: PreflightAddress[];
}

let adapters: Map<string, PlatformAdapter>;
let authManager: AuthManager | undefined;

export function setAdapters(a: Map<string, PlatformAdapter>): void {
  adapters = a;
}

export function setAuthManager(am: AuthManager): void {
  authManager = am;
}

const router = Router();

/**
 * POST /api/compare
 * Body: {
 *   restaurantId, address: {lat, lng, address}, items: [{itemId, quantity, modifierSelections?}],
 *   forceRefresh?: boolean, onlyPlatforms?: Platform[]
 * }
 * Per-platform response is either a PlatformComparison (kind: 'ok') or a PlatformError (kind: 'error').
 * HTTP status is always 200 as long as the request shape is valid — platform-level failures are in the body.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { restaurantId, address, items, forceRefresh, onlyPlatforms } = req.body;

    if (!restaurantId || !address || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Required: restaurantId, address (lat/lng/address), items array' });
    }

    const result = await compareOrder(restaurantId, items, address, adapters || undefined, {
      forceRefresh: Boolean(forceRefresh),
      onlyPlatforms: Array.isArray(onlyPlatforms) ? (onlyPlatforms as Platform[]) : undefined,
    });

    res.json({ comparison: result });
  } catch (err) {
    console.error('[Route] /compare error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/compare/refresh
 * Body: { restaurantId }
 * Clears the live-fee cache entries for a restaurant so the next compare hits platforms fresh.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const { restaurantId } = req.body;
  clearFeeCache(typeof restaurantId === 'string' ? restaurantId : undefined);
  res.json({ ok: true });
});

/**
 * GET /api/compare/preflight?restaurantId=...
 * Cheap per-platform readiness check. No cart mutations.
 */
router.get('/preflight', async (req: Request, res: Response) => {
  const restaurantId = typeof req.query.restaurantId === 'string' ? req.query.restaurantId : undefined;
  const statusMap: Record<string, string> = authManager
    ? authManager.getStatus()
    : { doordash: 'not_configured', seamless: 'not_configured' };

  const platforms: Platform[] = ['doordash', 'seamless'];
  const out: Record<string, PreflightPlatformStatus> = {};

  for (const p of platforms) {
    const adapter = adapters?.get(p);
    const status = statusMap[p];
    const locked = getActiveLock(`${p}-populate`);

    if (locked || !adapter) {
      out[p] = { ready: false, reason: 'adapter_unavailable' };
      continue;
    }
    if (status !== 'authenticated') {
      out[p] = { ready: false, reason: 'session_expired' };
      continue;
    }
    out[p] = { ready: true };
    if (adapter.getAccountAddresses) {
      try {
        const addrs = await adapter.getAccountAddresses();
        if (addrs.length > 0) out[p].accountAddresses = addrs;
      } catch (err) {
        console.warn(`[Preflight] ${p} getAccountAddresses failed:`, err);
      }
    }
  }

  res.json({ restaurantId, platforms: out });
});

export default router;
