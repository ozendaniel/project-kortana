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
  // Union-Find to group all transitively matched items
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  // Build connected components from matched_item_id links
  for (const row of rows) {
    const id = row.id as string;
    const matchedId = row.matched_item_id as string | null;
    find(id); // ensure every item is registered
    if (matchedId) union(id, matchedId);
  }

  // Group rows by their canonical (root) ID
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const root = find(row.id as string);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row);
  }

  // Build unified items from groups, skipping duplicate categories like "Most Ordered"
  const itemMap = new Map<string, UnifiedMenuItem>();
  const SKIP_CATEGORIES = new Set(['Most Ordered', 'Popular Items', 'Featured']);

  for (const [root, members] of groups) {
    // Pick the best representative row (prefer non-duplicate category)
    const representative = members.find(r => !SKIP_CATEGORIES.has(r.category as string)) || members[0];

    const unified: UnifiedMenuItem = {
      id: root,
      name: representative.original_name as string,
      description: representative.description as string | undefined,
      category: representative.category as string,
      platforms: {},
    };

    // Merge all platform entries from all members of this group
    for (const row of members) {
      const platform = row.platform as string;
      // Prefer the non-duplicate-category version for each platform
      if (!unified.platforms[platform] || SKIP_CATEGORIES.has(row.category as string) === false) {
        unified.platforms[platform] = {
          itemId: row.platform_item_id as string,
          priceCents: row.price_cents as number,
          available: row.available as boolean,
        };
      }
    }

    itemMap.set(root, unified);
  }

  // Group by category
  const categoryMap = new Map<string, UnifiedMenuItem[]>();
  for (const item of itemMap.values()) {
    const cat = item.category || 'Other';
    if (SKIP_CATEGORIES.has(cat)) continue; // don't show duplicate categories
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(item);
  }

  return Array.from(categoryMap.entries()).map(([category, items]) => ({
    category,
    items,
  }));
}

export default router;
