import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';

const router = Router();

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
              price_cents, category, platform_item_id, modifiers, matched_item_id, available
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

interface UnifiedMenuItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  platforms: Record<string, { itemId: string; priceCents: number; available: boolean }>;
}

interface MenuCategory {
  category: string;
  items: UnifiedMenuItem[];
}

function buildUnifiedMenu(rows: Array<Record<string, unknown>>): MenuCategory[] {
  const itemMap = new Map<string, UnifiedMenuItem>();
  const matchGroups = new Map<string, string>(); // matched_item_id -> canonical item id

  for (const row of rows) {
    const id = row.id as string;
    const matchedId = row.matched_item_id as string | null;

    // Determine canonical ID for this item group
    let canonicalId: string;
    if (matchedId && matchGroups.has(matchedId)) {
      canonicalId = matchGroups.get(matchedId)!;
    } else if (matchedId && itemMap.has(matchedId)) {
      canonicalId = matchedId;
    } else {
      canonicalId = id;
    }

    // Register the match group
    if (matchedId) {
      matchGroups.set(id, canonicalId);
      matchGroups.set(matchedId, canonicalId);
    }

    // Get or create the unified item
    if (!itemMap.has(canonicalId)) {
      itemMap.set(canonicalId, {
        id: canonicalId,
        name: row.original_name as string,
        description: row.description as string | undefined,
        category: row.category as string,
        platforms: {},
      });
    }

    const unified = itemMap.get(canonicalId)!;
    unified.platforms[row.platform as string] = {
      itemId: row.platform_item_id as string,
      priceCents: row.price_cents as number,
      available: row.available as boolean,
    };
  }

  // Group by category
  const categoryMap = new Map<string, UnifiedMenuItem[]>();
  for (const item of itemMap.values()) {
    const cat = item.category || 'Other';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(item);
  }

  return Array.from(categoryMap.entries()).map(([category, items]) => ({
    category,
    items,
  }));
}

export default router;
