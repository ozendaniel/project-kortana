import { db } from '../db/client.js';
import { jaroWinkler } from '../utils/fuzzyMatch.js';
import { cleanItemName } from '../utils/nameCleaner.js';

/**
 * Match menu items across platforms for a given restaurant.
 * Links items that represent the same dish on different platforms.
 *
 * Algorithm:
 *   1. De-duplicate DD items by platform_item_id (DD repeats items in "Most Ordered" etc.)
 *   2. Build all candidate pairs with combined score = nameScore × priceAgreement
 *   3. Sort by combined score descending
 *   4. Greedy 1-to-1 assignment (each SL item matched at most once)
 *   5. Propagate matches to DD duplicates (same platform_item_id → same match)
 *
 * Price agreement is critical because platforms sometimes collapse variant names
 * (e.g. Seamless shows "Beef Patties" at $2.99/$3.99/$4.99 for plain/cheese/cheese+pepperoni).
 * Name alone cannot distinguish these — price is the tiebreaker.
 */

const MIN_NAME_SCORE = 0.85;         // Minimum JW to even consider a pair
const MIN_COMBINED_SCORE = 0.78;     // Minimum combined score to accept a match
const CROSS_CATEGORY_NAME_MIN = 0.93; // Higher bar for matching across categories

export async function matchMenuItems(restaurantId: string): Promise<{
  matched: number;
  unmatched: number;
}> {
  // Get items from each platform
  const ddResult = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents, platform_item_id
     FROM menu_items
     WHERE restaurant_id = $1 AND platform = 'doordash'`,
    [restaurantId]
  );

  const slResult = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents, platform_item_id
     FROM menu_items
     WHERE restaurant_id = $1 AND platform = 'seamless'`,
    [restaurantId]
  );

  if (ddResult.rows.length === 0 || slResult.rows.length === 0) {
    return { matched: 0, unmatched: ddResult.rows.length };
  }

  // Clear ALL existing matches for this restaurant (both directions)
  await db.query(
    'UPDATE menu_items SET matched_item_id = NULL WHERE restaurant_id = $1',
    [restaurantId]
  );

  // De-duplicate DD items by platform_item_id — track all copies for propagation later
  const ddByPlatformId = new Map<string, typeof ddResult.rows>();
  for (const dd of ddResult.rows) {
    const key = dd.platform_item_id || dd.id;
    if (!ddByPlatformId.has(key)) ddByPlatformId.set(key, []);
    ddByPlatformId.get(key)!.push(dd);
  }

  // Representative DD items: prefer copy from a real menu category over "Most Ordered"
  // (DoorDash duplicates items into "Most Ordered" — that meta-category breaks category matching)
  const META_CATEGORIES = new Set(['most ordered', 'popular items', 'picked for you']);
  const ddUnique = Array.from(ddByPlatformId.values()).map(group => {
    const real = group.find(d => !META_CATEGORIES.has((d.category || '').toLowerCase()));
    return real || group[0];
  });

  // Build all candidate pairs with combined score
  const candidates: Array<{
    ddId: string;
    ddPlatformItemId: string;
    slId: string;
    score: number;
    nameScore: number;
    priceAgreement: number;
  }> = [];

  for (const dd of ddUnique) {
    const cleanDD = cleanItemName(dd.canonical_name);

    for (const sl of slResult.rows) {
      const cleanSL = cleanItemName(sl.canonical_name);
      const nameScore = jaroWinkler(cleanDD, cleanSL);

      if (nameScore < MIN_NAME_SCORE) continue;

      // Cross-category matches need higher name similarity
      const sameCategory = dd.category === sl.category;
      if (!sameCategory && nameScore < CROSS_CATEGORY_NAME_MIN) continue;

      // Price agreement: 1.0 when prices match, decreasing with divergence
      // This is the key signal when platforms use identical names for different variants
      const maxPrice = Math.max(dd.price_cents, sl.price_cents, 1);
      const priceDiffRatio = Math.abs(dd.price_cents - sl.price_cents) / maxPrice;
      const priceAgreement = Math.max(0.3, 1.0 - priceDiffRatio * 1.5);

      // Small category boost for same-category matches
      const categoryBoost = sameCategory ? 1.02 : 1.0;

      const score = nameScore * priceAgreement * categoryBoost;

      if (score >= MIN_COMBINED_SCORE) {
        candidates.push({
          ddId: dd.id,
          ddPlatformItemId: dd.platform_item_id || dd.id,
          slId: sl.id,
          score,
          nameScore,
          priceAgreement,
        });
      }
    }
  }

  // Sort by combined score descending — best matches first
  candidates.sort((a, b) => b.score - a.score);

  // Greedy 1-to-1 matching
  const matchedDDIds = new Set<string>();
  const matchedSLIds = new Set<string>();
  const matches: Array<{ ddPlatformItemId: string; slId: string }> = [];

  for (const c of candidates) {
    if (matchedDDIds.has(c.ddId) || matchedSLIds.has(c.slId)) continue;
    matches.push({ ddPlatformItemId: c.ddPlatformItemId, slId: c.slId });
    matchedDDIds.add(c.ddId);
    matchedSLIds.add(c.slId);
  }

  // Write matches to DB — propagate to ALL DD copies with same platform_item_id
  let totalDDMatched = 0;
  for (const m of matches) {
    const ddCopies = ddByPlatformId.get(m.ddPlatformItemId) || [];
    for (const dd of ddCopies) {
      await db.query('UPDATE menu_items SET matched_item_id = $1 WHERE id = $2', [m.slId, dd.id]);
      totalDDMatched++;
    }
    // Reverse link: SL → first DD copy
    await db.query('UPDATE menu_items SET matched_item_id = $1 WHERE id = $2', [
      ddCopies[0].id,
      m.slId,
    ]);
  }

  const unmatched = ddUnique.length - matches.length;

  console.log(
    `[Matching] Restaurant ${restaurantId}: ${matches.length} unique matched (${totalDDMatched} DD items linked), ${unmatched} unmatched`
  );
  return { matched: matches.length, unmatched };
}

/**
 * Validate match quality for a restaurant. Returns suspicious matches
 * where prices differ — these likely indicate matching errors.
 * Use after bulk operations to catch problems before they scale.
 */
export async function validateMatches(restaurantId: string): Promise<{
  total: number;
  perfectPrice: number;
  suspicious: Array<{
    ddName: string;
    slName: string;
    ddPrice: number;
    slPrice: number;
    diffCents: number;
  }>;
}> {
  const result = await db.query(`
    SELECT dd.original_name as dd_name, dd.price_cents as dd_price,
           sl.original_name as sl_name, sl.price_cents as sl_price
    FROM menu_items dd
    JOIN menu_items sl ON dd.matched_item_id = sl.id
    WHERE dd.restaurant_id = $1 AND dd.platform = 'doordash' AND sl.platform = 'seamless'
  `, [restaurantId]);

  const suspicious: Array<{
    ddName: string; slName: string; ddPrice: number; slPrice: number; diffCents: number;
  }> = [];

  let perfectPrice = 0;
  for (const row of result.rows) {
    const diff = Math.abs(row.dd_price - row.sl_price);
    if (diff === 0) {
      perfectPrice++;
    } else {
      suspicious.push({
        ddName: row.dd_name,
        slName: row.sl_name,
        ddPrice: row.dd_price,
        slPrice: row.sl_price,
        diffCents: diff,
      });
    }
  }

  return { total: result.rows.length, perfectPrice, suspicious };
}
