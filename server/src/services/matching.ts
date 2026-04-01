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

  // Build a map of Seamless items by cleaned name for fast lookup
  const slByCleanName = new Map<string, typeof slItems.rows[0]>();
  for (const slItem of slItems.rows) {
    slByCleanName.set(cleanItemName(slItem.canonical_name), slItem);
  }

  for (const ddItem of ddItems.rows) {
    const cleanDD = cleanItemName(ddItem.canonical_name);
    let bestMatch: { id: string; score: number } | null = null;

    // Fast path: exact cleaned name match
    const exactMatch = slByCleanName.get(cleanDD);
    if (exactMatch) {
      bestMatch = { id: exactMatch.id, score: 1.0 };
    } else {
      // Fuzzy match against all Seamless items
      for (const slItem of slItems.rows) {
        const cleanSL = cleanItemName(slItem.canonical_name);
        const similarity = jaroWinkler(cleanDD, cleanSL);

        if (similarity >= EXACT_MATCH_THRESHOLD) {
          if (!bestMatch || similarity > bestMatch.score) {
            bestMatch = { id: slItem.id, score: similarity };
          }
        } else if (similarity >= CATEGORY_MATCH_THRESHOLD && ddItem.category === slItem.category) {
          if (!bestMatch || similarity > bestMatch.score) {
            bestMatch = { id: slItem.id, score: similarity };
          }
        }
      }
    }

    if (bestMatch) {
      // Link DoorDash item → Seamless item (allows many DD items to match one SL item,
      // which happens when DoorDash duplicates items across categories like "Popular")
      await db.query('UPDATE menu_items SET matched_item_id = $1 WHERE id = $2', [
        bestMatch.id,
        ddItem.id,
      ]);
      // Also set the reverse link if not already set
      await db.query(
        'UPDATE menu_items SET matched_item_id = $1 WHERE id = $2 AND matched_item_id IS NULL',
        [ddItem.id, bestMatch.id]
      );
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
