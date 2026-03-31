import { db } from '../db/client.js';
import { jaroWinkler } from '../utils/fuzzyMatch.js';
import { cleanItemName } from '../utils/nameCleaner.js';

const EXACT_MATCH_THRESHOLD = 0.90;
const CATEGORY_MATCH_THRESHOLD = 0.80;

/**
 * Match menu items across platforms for a given restaurant.
 * Links items that represent the same dish on different platforms.
 */
export async function matchMenuItems(restaurantId: string): Promise<{
  matched: number;
  unmatched: number;
}> {
  let matched = 0;
  let unmatched = 0;

  // Get items from each platform for this restaurant
  const ddItems = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents
     FROM menu_items
     WHERE restaurant_id = $1 AND platform = 'doordash' AND matched_item_id IS NULL`,
    [restaurantId]
  );

  const slItems = await db.query(
    `SELECT id, canonical_name, original_name, category, price_cents
     FROM menu_items
     WHERE restaurant_id = $1 AND platform = 'seamless' AND matched_item_id IS NULL`,
    [restaurantId]
  );

  const usedSeamlessIds = new Set<string>();

  for (const ddItem of ddItems.rows) {
    const cleanDD = cleanItemName(ddItem.canonical_name);
    let bestMatch: { id: string; score: number } | null = null;

    for (const slItem of slItems.rows) {
      if (usedSeamlessIds.has(slItem.id)) continue;

      const cleanSL = cleanItemName(slItem.canonical_name);

      // Exact cleaned name match
      if (cleanDD === cleanSL) {
        bestMatch = { id: slItem.id, score: 1.0 };
        break;
      }

      const similarity = jaroWinkler(cleanDD, cleanSL);

      // High similarity → auto-match
      if (similarity >= EXACT_MATCH_THRESHOLD) {
        if (!bestMatch || similarity > bestMatch.score) {
          bestMatch = { id: slItem.id, score: similarity };
        }
        continue;
      }

      // Moderate similarity + same category → match
      if (similarity >= CATEGORY_MATCH_THRESHOLD && ddItem.category === slItem.category) {
        if (!bestMatch || similarity > bestMatch.score) {
          bestMatch = { id: slItem.id, score: similarity };
        }
      }
    }

    if (bestMatch) {
      // Link the two items
      await db.query('UPDATE menu_items SET matched_item_id = $1 WHERE id = $2', [
        bestMatch.id,
        ddItem.id,
      ]);
      await db.query('UPDATE menu_items SET matched_item_id = $1 WHERE id = $2', [
        ddItem.id,
        bestMatch.id,
      ]);
      usedSeamlessIds.add(bestMatch.id);
      matched++;
    } else {
      unmatched++;
    }
  }

  console.log(
    `[Matching] Restaurant ${restaurantId}: ${matched} matched, ${unmatched} unmatched`
  );
  return { matched, unmatched };
}
