import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';

const router = Router();

/**
 * GET /api/savings
 * Aggregate savings stats across all orders.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // Overall stats
    const statsResult = await db.query(`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(savings_cents), 0) as total_savings_cents,
        COALESCE(AVG(savings_cents), 0) as avg_savings_cents
      FROM orders
    `);

    // Per-platform breakdown
    const platformResult = await db.query(`
      SELECT
        platform_used,
        COUNT(*) as times_chosen,
        SUM(total_cents) as total_spent_cents
      FROM orders
      GROUP BY platform_used
    `);

    // Recent orders
    const recentResult = await db.query(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT 10'
    );

    const stats = statsResult.rows[0];
    const platformBreakdown: Record<string, { timesChosen: number; totalSpentCents: number }> = {};
    for (const row of platformResult.rows) {
      platformBreakdown[row.platform_used] = {
        timesChosen: parseInt(row.times_chosen),
        totalSpentCents: parseInt(row.total_spent_cents),
      };
    }

    res.json({
      totalOrders: parseInt(stats.total_orders),
      totalSavingsCents: parseInt(stats.total_savings_cents),
      averageSavingsPerOrderCents: Math.round(parseFloat(stats.avg_savings_cents)),
      platformBreakdown,
      recentOrders: recentResult.rows,
    });
  } catch (err) {
    console.error('[Route] /savings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
