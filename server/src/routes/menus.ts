import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';
import { buildUnifiedMenu } from '../services/menu-utils.js';

const router = Router();

/**
 * GET /api/menus/items/:itemId/modifiers
 * Returns modifier groups for a specific menu item.
 * Must be registered before /:restaurantId to avoid param collision.
 */
router.get('/items/:itemId/modifiers', async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;

    // Get modifier_groups for this item or its matched counterpart (prefer DD as source)
    const result = await db.query(
      `SELECT mi.id, mi.platform, mi.original_name, mi.modifier_groups
       FROM menu_items mi
       WHERE (mi.id = $1 OR mi.matched_item_id = $1)
         AND mi.modifier_groups IS NOT NULL
       ORDER BY mi.platform = 'doordash' DESC
       LIMIT 1`,
      [itemId]
    );

    if (result.rows.length === 0 || !result.rows[0].modifier_groups) {
      return res.json({ modifierGroups: [] });
    }

    res.json({ modifierGroups: result.rows[0].modifier_groups });
  } catch (err) {
    console.error('[Route] /menus/items/:itemId/modifiers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/menus/:restaurantId
 * Returns unified menu with per-platform prices for each item.
 */
router.get('/:restaurantId', async (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.params;

    // Get restaurant info
    const restResult = await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    if (restResult.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Get all menu items for this restaurant across platforms
    const itemsResult = await db.query(
      `SELECT id, platform, canonical_name, original_name, description,
              price_cents, category, platform_item_id, modifier_groups, matched_item_id, available
       FROM menu_items
       WHERE restaurant_id = $1
       ORDER BY category, canonical_name`,
      [restaurantId]
    );

    // Group items into unified menu: merge matched items across platforms
    const unifiedMenu = buildUnifiedMenu(itemsResult.rows);

    res.json({
      restaurant: {
        id: restResult.rows[0].id,
        name: restResult.rows[0].canonical_name,
        address: restResult.rows[0].address,
      },
      menu: unifiedMenu,
    });
  } catch (err) {
    console.error('[Route] /menus/:restaurantId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
