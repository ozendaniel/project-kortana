import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';
import { geocodeAddress } from '../utils/geocode.js';
import { mergeMatchedItems } from '../services/menu-utils.js';

const router = Router();

/**
 * GET /api/menu-items/search?address={address}&q={query}&radius={km}&cuisine={type}&limit={n}
 * Search menu items by name, grouped by restaurant.
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { address, q } = req.query;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address query parameter is required' });
    }
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: 'q query parameter is required (min 2 characters)' });
    }

    const radiusKm = Math.min(Math.max(parseFloat(req.query.radius as string) || 8, 1), 25);
    const cuisine = req.query.cuisine as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);

    // Geocode
    const geo = await geocodeAddress(address);
    if (!geo) {
      return res.status(400).json({ error: 'Unable to geocode address' });
    }

    // Bounding box
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.cos(geo.lat * Math.PI / 180));

    // Escape ILIKE wildcards in user input
    const escapedQ = q.replace(/[%_\\]/g, '\\$&');

    // Build query: find menu items matching the search term at nearby restaurants
    let query = `
      SELECT r.id AS restaurant_id, r.canonical_name AS restaurant_name, r.address AS restaurant_address,
             r.doordash_id, r.seamless_id, r.platform_status,
             mi.id, mi.canonical_name, mi.original_name, mi.description,
             mi.price_cents, mi.category, mi.platform, mi.platform_item_id,
             mi.matched_item_id, mi.available
      FROM menu_items mi
      JOIN restaurants r ON r.id = mi.restaurant_id
      WHERE r.lat BETWEEN $1 AND $2 AND r.lng BETWEEN $3 AND $4
        AND mi.canonical_name ILIKE $5
        AND mi.available = true
    `;
    const params: unknown[] = [
      geo.lat - latDelta, geo.lat + latDelta,
      geo.lng - lngDelta, geo.lng + lngDelta,
      `%${escapedQ}%`,
    ];

    // Exclude restaurants delisted on every platform they're on.
    // A DD-only restaurant (seamless_id IS NULL) is fine if DD isn't delisted.
    query += ` AND (
      (r.doordash_id IS NOT NULL AND COALESCE(r.platform_status->>'doordash', '') != 'delisted')
      OR (r.seamless_id IS NOT NULL AND COALESCE(r.platform_status->>'seamless', '') != 'delisted')
    )`;

    // Optional cuisine filter
    if (cuisine && typeof cuisine === 'string') {
      params.push(`%${cuisine}%`);
      query += ` AND array_to_string(r.cuisine_tags, ',') ILIKE $${params.length}`;
    }

    query += ' ORDER BY r.canonical_name, mi.canonical_name';

    const result = await db.query(query, params);

    // Group by restaurant
    const restaurantMap = new Map<string, {
      restaurant: {
        id: string;
        name: string;
        address: string;
        platforms: Record<string, { available: boolean }>;
      };
      rows: Array<Record<string, unknown>>;
    }>();

    for (const row of result.rows) {
      const rid = row.restaurant_id as string;
      if (!restaurantMap.has(rid)) {
        const platforms: Record<string, { available: boolean }> = {};
        if (row.doordash_id && (row.platform_status as Record<string, string> | null)?.doordash !== 'delisted') {
          platforms.doordash = { available: true };
        }
        if (row.seamless_id && (row.platform_status as Record<string, string> | null)?.seamless !== 'delisted') {
          platforms.seamless = { available: true };
        }
        restaurantMap.set(rid, {
          restaurant: {
            id: rid,
            name: row.restaurant_name as string,
            address: row.restaurant_address as string || '',
            platforms,
          },
          rows: [],
        });
      }
      restaurantMap.get(rid)!.rows.push(row);
    }

    // For each restaurant: merge matched items, apply ghost filter, cap results
    const results: Array<{
      restaurant: typeof restaurantMap extends Map<string, { restaurant: infer R }> ? R : never;
      matchingItems: Array<{
        id: string;
        name: string;
        description?: string;
        category: string;
        platforms: Record<string, { priceCents: number }>;
      }>;
      totalMatches: number;
    }> = [];

    let totalItems = 0;

    for (const [, entry] of restaurantMap) {
      // We need ALL items for this restaurant to do proper Union-Find matching,
      // but we only have the matching ones from our query. For ghost filtering to work
      // correctly, we need to know if the matched item has a DD counterpart.
      // The mergeMatchedItems function handles this via matched_item_id links.
      const unified = mergeMatchedItems(entry.rows);

      if (unified.length === 0) continue;

      totalItems += unified.length;
      results.push({
        restaurant: entry.restaurant,
        matchingItems: unified.slice(0, 5).map(item => ({
          id: item.id,
          name: item.name,
          description: item.description,
          category: item.category,
          platforms: Object.fromEntries(
            Object.entries(item.platforms).map(([p, v]) => [p, { priceCents: v.priceCents }])
          ),
        })),
        totalMatches: unified.length,
      });
    }

    // Sort: most matches first, both-platform restaurants first, then alphabetical
    results.sort((a, b) => {
      // Both platforms first
      const aPlatforms = Object.keys(a.restaurant.platforms).length;
      const bPlatforms = Object.keys(b.restaurant.platforms).length;
      if (bPlatforms !== aPlatforms) return bPlatforms - aPlatforms;
      // More matches first
      if (b.totalMatches !== a.totalMatches) return b.totalMatches - a.totalMatches;
      // Alphabetical
      return a.restaurant.name.localeCompare(b.restaurant.name);
    });

    res.json({
      results: results.slice(0, limit),
      location: geo,
      totalItems,
    });
  } catch (err) {
    console.error('[Route] /menu-items/search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
