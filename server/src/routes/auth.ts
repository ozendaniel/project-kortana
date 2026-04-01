import { Router, type Request, type Response } from 'express';
import type { AuthManager } from '../services/auth-manager.js';

let authManager: AuthManager;

export function setAuthManager(am: AuthManager): void {
  authManager = am;
}

const router = Router();

/** GET /api/auth/status — returns auth status for all platforms */
router.get('/status', (_req: Request, res: Response) => {
  if (!authManager) {
    return res.json({ doordash: 'not_configured', seamless: 'not_configured' });
  }
  res.json(authManager.getStatus());
});

/** POST /api/auth/logout/:platform — clears session for a platform */
router.post('/logout/:platform', async (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!authManager) {
    return res.status(404).json({ error: 'Auth manager not initialized' });
  }
  // Stop any active login and mark as expired
  await authManager.stopLogin(platform);
  res.json({ status: 'logged_out' });
});

export default router;
