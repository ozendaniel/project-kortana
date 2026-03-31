import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';

const router = Router();

/**
 * POST /api/orders
 * Log a completed order with comparison data.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      restaurantId,
      platformUsed,
      items,
      subtotalCents,
      deliveryFeeCents,
      serviceFeeCents,
      totalCents,
      comparisonData,
      savingsCents,
    } = req.body;

    const result = await db.query(
      `INSERT INTO orders
       (restaurant_id, platform_used, items, subtotal_cents, delivery_fee_cents,
        service_fee_cents, total_cents, comparison_data, savings_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        restaurantId,
        platformUsed,
        JSON.stringify(items),
        subtotalCents,
        deliveryFeeCents,
        serviceFeeCents,
        totalCents,
        JSON.stringify(comparisonData),
        savingsCents,
      ]
    );

    res.status(201).json({ orderId: result.rows[0].id });
  } catch (err) {
    console.error('[Route] POST /orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/orders
 * List recent orders.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('[Route] GET /orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
