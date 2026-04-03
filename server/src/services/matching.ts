import { db } from '../db/client.js';
import { jaroWinkler } from '../utils/fuzzyMatch.js';
import { cleanItemName } from '../utils/nameCleaner.js';

/**
 * Match menu items across platforms for a given restaurant.
 * Links items that represent the same dish on different platforms.
 *
 * Two-pass algorithm:
 *
 *   Pass 1 — Name + Price matching:
 *     Score = nameScore × priceAgreement × categoryBoost
 *     Greedy 1-to-1 assignment sorted by combined score.
 *
 *   Pass 2 — Description-enriched matching (remaining unmatched only):
 *     Platforms split item info differently: DoorDash puts variant details in the name
 *     ("Chicken with Bacon & Ranch"), Seamless puts them in the description
 *     ("Chicken Pizza" + desc "With bacon & ranch."). Pass 2 enriches SL names with
 *     their description text, and DD names with their description text, then re-scores.
 *
 * Both passes use price agreement as a guardrail and 1-to-1 greedy assignment.
 * DD items are de-duplicated by platform_item_id; matches propagate to all copies.
 */

const MIN_NAME_SCORE = 0.85;         // Minimum JW to even consider a pair
const MIN_COMBINED_SCORE = 0.78;     // Minimum combined score to accept a match
const CROSS_CATEGORY_NAME_MIN = 0.93; // Higher bar for matching across categories

// Pass 2 thresholds (description-enriched) — slightly more lenient on name
// since enriched strings are longer and JW scores compress for longer strings
const PASS2_MIN_NAME_SCORE = 0.83;
const PASS2_MIN_COMBINED_SCORE = 0.78;

interface ItemRow {
  id: string;
  canonical_name: string;
  original_name: string;
  category: string;
  price_cents: number;
  platform_item_id: string;
  description: string | null;
}

interface CandidatePair {
  ddId: string;
  ddPlatformItemId: string;
  slId: string;
  score: number;
  nameScore: number;
  priceAgreement: number;
}

const META_CATEGORIES = new Set(['most ordered', 'popular items', 'picked for you']);

/** Score a (DD, SL) pair. Returns null if below thresholds. */
function scorePair(
  cleanDD: string,
  cleanSL: string,
  ddCategory: string,
  slCategory: string,
  ddPrice: number,
  slPrice: number,
  minNameScore: number,
  minCombined: number,
): { nameScore: number; priceAgreement: number; score: number } | null {
  const nameScore = jaroWinkler(cleanDD, cleanSL);
  if (nameScore < minNameScore) return null;

  const sameCategory = ddCategory === slCategory;
  if (!sameCategory && nameScore < CROSS_CATEGORY_NAME_MIN) return null;

  const maxPrice = Math.max(ddPrice, slPrice, 1);
  const priceDiffRatio = Math.abs(ddPrice - slPrice) / maxPrice;
  const priceAgreement = Math.max(0.3, 1.0 - priceDiffRatio * 1.5);

  const categoryBoost = sameCategory ? 1.02 : 1.0;
  const score = nameScore * priceAgreement * categoryBoost;

  if (score < minCombined) return null;
  return { nameScore, priceAgreement, score };
}

export async function matchMenuItems(restaurantId: string): Promise<{
  matched: number;
  unmatched: number;
}> {
  // Get items from each platform (include description for Pass 2)
  const ddResult = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents, platform_item_id, description
     FROM menu_items
     WHERE restaurant_id = $1 AND platform = 'doordash'`,
    [restaurantId]
  );

  const slResult = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents, platform_item_id, description
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

  // De-duplicate DD items by platform_item_id — track all copies for propagation
  const ddByPlatformId = new Map<string, ItemRow[]>();
  for (const dd of ddResult.rows as ItemRow[]) {
    const key = dd.platform_item_id || dd.id;
    if (!ddByPlatformId.has(key)) ddByPlatformId.set(key, []);
    ddByPlatformId.get(key)!.push(dd);
  }

  // Representative DD items: prefer real category over meta-categories
  const ddUnique = Array.from(ddByPlatformId.values()).map(group => {
    const real = group.find(d => !META_CATEGORIES.has((d.category || '').toLowerCase()));
    return real || group[0];
  });

  // ==================== Pass 1: Name + Price ====================
  const candidates: CandidatePair[] = [];

  for (const dd of ddUnique) {
    const cleanDD = cleanItemName(dd.canonical_name);
    for (const sl of slResult.rows as ItemRow[]) {
      const cleanSL = cleanItemName(sl.canonical_name);
      const result = scorePair(
        cleanDD, cleanSL,
        dd.category, sl.category,
        dd.price_cents, sl.price_cents,
        MIN_NAME_SCORE, MIN_COMBINED_SCORE,
      );
      if (result) {
        candidates.push({
          ddId: dd.id,
          ddPlatformItemId: dd.platform_item_id || dd.id,
          slId: sl.id,
          ...result,
        });
      }
    }
  }

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

  const pass1Count = matches.length;

  // ==================== Pass 2: Description-Enriched ====================
  // For remaining unmatched items, try matching with description text appended.
  // Handles: DD "Chicken with Bacon & Ranch" vs SL "Chicken Pizza" (desc: "With bacon & ranch.")
  const unmatchedDD = ddUnique.filter(d => !matchedDDIds.has(d.id));
  const unmatchedSL = (slResult.rows as ItemRow[]).filter(s => !matchedSLIds.has(s.id));

  if (unmatchedDD.length > 0 && unmatchedSL.length > 0) {
    const pass2Candidates: CandidatePair[] = [];

    for (const dd of unmatchedDD) {
      const cleanDD = cleanItemName(dd.canonical_name);
      // DD name enriched with its own description
      const ddDesc = dd.description || '';
      const cleanDDEnriched = ddDesc ? cleanItemName(dd.canonical_name + ' ' + ddDesc) : '';

      for (const sl of unmatchedSL) {
        const cleanSL = cleanItemName(sl.canonical_name);
        // SL name enriched with its own description
        const slDesc = sl.description || '';
        const cleanSLEnriched = slDesc ? cleanItemName(sl.canonical_name + ' ' + slDesc) : '';

        // Try all enrichment combinations — take the best score:
        // 1. DD name vs SL name+desc (SL puts variant in description)
        // 2. DD name+desc vs SL name (DD puts variant in description)
        // 3. DD name+desc vs SL name+desc (both have useful descriptions)
        let bestResult: { nameScore: number; priceAgreement: number; score: number } | null = null;

        const tryPairs: [string, string][] = [];
        if (cleanSLEnriched) tryPairs.push([cleanDD, cleanSLEnriched]);
        if (cleanDDEnriched) tryPairs.push([cleanDDEnriched, cleanSL]);
        if (cleanDDEnriched && cleanSLEnriched) tryPairs.push([cleanDDEnriched, cleanSLEnriched]);

        for (const [a, b] of tryPairs) {
          const result = scorePair(
            a, b,
            dd.category, sl.category,
            dd.price_cents, sl.price_cents,
            PASS2_MIN_NAME_SCORE, PASS2_MIN_COMBINED_SCORE,
          );
          if (result && (!bestResult || result.score > bestResult.score)) {
            bestResult = result;
          }
        }

        if (bestResult) {
          pass2Candidates.push({
            ddId: dd.id,
            ddPlatformItemId: dd.platform_item_id || dd.id,
            slId: sl.id,
            ...bestResult,
          });
        }
      }
    }

    pass2Candidates.sort((a, b) => b.score - a.score);

    for (const c of pass2Candidates) {
      if (matchedDDIds.has(c.ddId) || matchedSLIds.has(c.slId)) continue;
      matches.push({ ddPlatformItemId: c.ddPlatformItemId, slId: c.slId });
      matchedDDIds.add(c.ddId);
      matchedSLIds.add(c.slId);
    }
  }

  const pass2Count = matches.length - pass1Count;

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
    `[Matching] Restaurant ${restaurantId}: ${matches.length} unique matched (${totalDDMatched} DD items linked), ${unmatched} unmatched` +
    (pass2Count > 0 ? ` (${pass1Count} pass1 + ${pass2Count} pass2-enriched)` : '')
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
