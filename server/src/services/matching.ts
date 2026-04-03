import { db } from '../db/client.js';
import { jaroWinkler } from '../utils/fuzzyMatch.js';
import { cleanItemName } from '../utils/nameCleaner.js';

/**
 * Match menu items across platforms for a given restaurant.
 *
 * Three-tier matching with name as primary signal:
 *
 *   Tier 1 — High-confidence name (JW ≥ 0.95):
 *     Accept regardless of price. Price only breaks ties between multiple candidates.
 *     Handles: "Shanghai Juicy Pork Bun" DD $12.95 vs SL $8.95 (different qty, same item).
 *
 *   Tier 2 — Good name (JW ≥ 0.85) + same normalized category:
 *     Accept with soft price boost (0.85–1.0 range, NOT 0.3–1.0).
 *     Handles: "Chicken Feet W.peanut" ≈ "Chicken Feet" in same category.
 *
 *   Tier 3 — Description-enriched (JW ≥ 0.83 after name+description concatenation):
 *     Handles: DD "Chicken with Bacon & Ranch" vs SL "Chicken Pizza" (desc "With bacon & ranch").
 *
 * All tiers use 1-to-1 greedy matching. DD items de-duped by platform_item_id.
 *
 * Key insight: price should NEVER reject a strong name match. Platforms sell different
 * quantities/sizes at different prices — that's a real price difference to show users,
 * not a matching error.
 */

// --- Thresholds ---
const TIER1_NAME_MIN = 0.95;         // High confidence — match regardless of price
const TIER2_NAME_MIN = 0.85;         // Good name — needs same category
const TIER3_NAME_MIN = 0.83;         // Description-enriched
const CROSS_CATEGORY_NAME_MIN = 0.93; // Higher bar for matching across categories
const TIER2_MIN_COMBINED = 0.82;     // Minimum combined score for Tier 2

// --- Category normalization ---
// Platforms use different category names for the same thing.
// Map each known variant to a canonical form.
const CATEGORY_CANONICAL: Record<string, string> = {
  'dimsum': 'dim sum',
  'dim sum': 'dim sum',
  'beef and lamb': 'beef and lamb',
  'beef & lamb': 'beef and lamb',
  'vegetarian': 'vegetable',
  'vegetable': 'vegetable',
  'fried rice': 'rice',
  'rice': 'rice',
  'noodles': 'noodle',
  'noodle': 'noodle',
  'noodles soup': 'noodle soup',
  'noodle soup': 'noodle soup',
  'chefs signature dishes': 'chef specials',
  'chef specials': 'chef specials',
  'beverages': 'drinks',
  'soft drink': 'drinks',
  'juice': 'drinks',
  'congee': 'congee',
  'special': 'special',
  'lunch special': 'lunch special',
  'catering': 'catering',
};

function normalizeCategory(cat: string): string {
  const lower = cat.toLowerCase().trim();
  return CATEGORY_CANONICAL[lower] || lower;
}

const META_CATEGORIES = new Set(['most ordered', 'popular items', 'picked for you']);

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
  tier: number;
}

/** Compute price closeness: 1.0 when identical, decreasing toward 0.0 */
function priceCloseness(a: number, b: number): number {
  const max = Math.max(a, b, 1);
  return 1.0 - Math.abs(a - b) / max;
}

export async function matchMenuItems(restaurantId: string): Promise<{
  matched: number;
  unmatched: number;
}> {
  // Get items from each platform (include description for Tier 3)
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

  // Clear ALL existing matches for this restaurant
  await db.query(
    'UPDATE menu_items SET matched_item_id = NULL WHERE restaurant_id = $1',
    [restaurantId]
  );

  // De-duplicate DD items by platform_item_id
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

  const slItems = slResult.rows as ItemRow[];

  // Pre-compute cleaned names and normalized categories
  const ddClean = ddUnique.map(d => ({
    ...d,
    cleaned: cleanItemName(d.canonical_name),
    normCat: normalizeCategory(d.category),
  }));
  const slClean = slItems.map(s => ({
    ...s,
    cleaned: cleanItemName(s.canonical_name),
    normCat: normalizeCategory(s.category),
  }));

  // ==================== Build all candidate pairs ====================
  const candidates: CandidatePair[] = [];

  for (const dd of ddClean) {
    for (const sl of slClean) {
      const nameScore = jaroWinkler(dd.cleaned, sl.cleaned);
      const sameCategory = dd.normCat === sl.normCat;

      // Tier 1: High-confidence name — match regardless of price
      if (nameScore >= TIER1_NAME_MIN) {
        // Price is just a cosmetic tiebreaker (0.001 scale so it doesn't override name)
        const score = nameScore + priceCloseness(dd.price_cents, sl.price_cents) * 0.01;
        candidates.push({
          ddId: dd.id,
          ddPlatformItemId: dd.platform_item_id || dd.id,
          slId: sl.id,
          score,
          tier: 1,
        });
        continue;
      }

      // Tier 2: Good name + same category, soft price boost
      if (nameScore >= TIER2_NAME_MIN) {
        if (!sameCategory && nameScore < CROSS_CATEGORY_NAME_MIN) continue;

        // Block lunch↔dinner cross-matching: if one name contains "lunch" and the
        // other doesn't, they're different menu sections even if names are similar
        const ddHasLunch = dd.cleaned.includes('lunch') || dd.normCat === 'lunch special';
        const slHasLunch = sl.cleaned.includes('lunch') || sl.normCat === 'lunch special';
        if (ddHasLunch !== slHasLunch) continue;

        // Soft price boost: 0.85 to 1.0 (never kills a good name match)
        const softPrice = 0.85 + priceCloseness(dd.price_cents, sl.price_cents) * 0.15;
        const categoryBoost = sameCategory ? 1.02 : 1.0;
        const combined = nameScore * softPrice * categoryBoost;

        if (combined >= TIER2_MIN_COMBINED) {
          candidates.push({
            ddId: dd.id,
            ddPlatformItemId: dd.platform_item_id || dd.id,
            slId: sl.id,
            score: combined,
            tier: 2,
          });
        }
      }
    }
  }

  // Sort by score descending — Tier 1 naturally floats to top
  candidates.sort((a, b) => b.score - a.score);

  // Greedy 1-to-1 matching
  const matchedDDIds = new Set<string>();
  const matchedSLIds = new Set<string>();
  const matches: Array<{ ddPlatformItemId: string; slId: string; tier: number }> = [];

  for (const c of candidates) {
    if (matchedDDIds.has(c.ddId) || matchedSLIds.has(c.slId)) continue;
    matches.push({ ddPlatformItemId: c.ddPlatformItemId, slId: c.slId, tier: c.tier });
    matchedDDIds.add(c.ddId);
    matchedSLIds.add(c.slId);
  }

  const tier1Count = matches.filter(m => m.tier === 1).length;
  const tier2Count = matches.filter(m => m.tier === 2).length;

  // ==================== Tier 3: Description-enriched ====================
  const unmatchedDD = ddClean.filter(d => !matchedDDIds.has(d.id));
  const unmatchedSL = slClean.filter(s => !matchedSLIds.has(s.id));

  let tier3Count = 0;
  if (unmatchedDD.length > 0 && unmatchedSL.length > 0) {
    const tier3Candidates: CandidatePair[] = [];

    for (const dd of unmatchedDD) {
      const ddDesc = dd.description || '';
      const ddEnriched = ddDesc ? cleanItemName(dd.canonical_name + ' ' + ddDesc) : '';

      for (const sl of unmatchedSL) {
        const slDesc = sl.description || '';
        const slEnriched = slDesc ? cleanItemName(sl.canonical_name + ' ' + slDesc) : '';

        // Try all enrichment combinations — take the best
        let bestScore = 0;
        const tryPairs: [string, string][] = [];
        if (slEnriched) tryPairs.push([dd.cleaned, slEnriched]);
        if (ddEnriched) tryPairs.push([ddEnriched, sl.cleaned]);
        if (ddEnriched && slEnriched) tryPairs.push([ddEnriched, slEnriched]);

        for (const [a, b] of tryPairs) {
          const nameScore = jaroWinkler(a, b);
          if (nameScore < TIER3_NAME_MIN) continue;

          const sameCategory = dd.normCat === sl.normCat;
          if (!sameCategory && nameScore < CROSS_CATEGORY_NAME_MIN) continue;

          const softPrice = 0.85 + priceCloseness(dd.price_cents, sl.price_cents) * 0.15;
          const categoryBoost = sameCategory ? 1.02 : 1.0;
          const score = nameScore * softPrice * categoryBoost;

          if (score > bestScore && score >= TIER2_MIN_COMBINED) {
            bestScore = score;
          }
        }

        if (bestScore > 0) {
          tier3Candidates.push({
            ddId: dd.id,
            ddPlatformItemId: dd.platform_item_id || dd.id,
            slId: sl.id,
            score: bestScore,
            tier: 3,
          });
        }
      }
    }

    tier3Candidates.sort((a, b) => b.score - a.score);

    for (const c of tier3Candidates) {
      if (matchedDDIds.has(c.ddId) || matchedSLIds.has(c.slId)) continue;
      matches.push({ ddPlatformItemId: c.ddPlatformItemId, slId: c.slId, tier: 3 });
      matchedDDIds.add(c.ddId);
      matchedSLIds.add(c.slId);
      tier3Count++;
    }
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
  const tierBreakdown = `${tier1Count} T1 + ${tier2Count} T2 + ${tier3Count} T3`;

  console.log(
    `[Matching] Restaurant ${restaurantId}: ${matches.length} unique matched (${totalDDMatched} DD items linked), ${unmatched} unmatched (${tierBreakdown})`
  );
  return { matched: matches.length, unmatched };
}

/**
 * Validate match quality for a restaurant. Returns suspicious matches
 * where prices differ — these likely indicate matching errors.
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
