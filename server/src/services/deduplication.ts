import { db } from '../db/client.js';
import { jaroWinkler, computeMatchConfidence } from '../utils/fuzzyMatch.js';
import { cleanRestaurantName, cleanItemName } from '../utils/nameCleaner.js';
import { haversineDistance } from '../utils/geocode.js';

const AUTO_MERGE_THRESHOLD = 0.80;
const REVIEW_THRESHOLD = 0.60;

/**
 * Run the restaurant deduplication pipeline.
 * Matches unmatched restaurants across platforms.
 */
export async function deduplicateRestaurants(): Promise<{
  merged: number;
  flagged: number;
}> {
  let merged = 0;
  let flagged = 0;

  // Find DoorDash restaurants without a Seamless match
  const unmatchedDD = await db.query(
    `SELECT id, canonical_name, address, lat, lng, phone, doordash_id
     FROM restaurants
     WHERE doordash_id IS NOT NULL AND seamless_id IS NULL`
  );

  // Find all Seamless-only restaurants as candidates
  const seamlessCandidates = await db.query(
    `SELECT id, canonical_name, address, lat, lng, phone, seamless_id
     FROM restaurants
     WHERE seamless_id IS NOT NULL AND doordash_id IS NULL`
  );

  for (const ddRest of unmatchedDD.rows) {
    if (!ddRest.lat || !ddRest.lng) continue;

    let bestMatch: { id: string; confidence: number } | null = null;

    for (const slRest of seamlessCandidates.rows) {
      if (!slRest.lat || !slRest.lng) continue;

      const distance = haversineDistance(ddRest.lat, ddRest.lng, slRest.lat, slRest.lng);
      if (distance > 200) continue; // Skip if too far

      const cleanDD = cleanRestaurantName(ddRest.canonical_name);
      const cleanSL = cleanRestaurantName(slRest.canonical_name);
      const nameSimilarity = jaroWinkler(cleanDD, cleanSL);

      const phoneMatch =
        ddRest.phone && slRest.phone && ddRest.phone === slRest.phone;

      // Menu overlap (compute if we have menu data)
      const menuOverlap = await computeMenuOverlap(ddRest.id, slRest.id);

      const confidence = computeMatchConfidence({
        nameSimilarity,
        distanceMeters: distance,
        phoneMatch: !!phoneMatch,
        menuOverlap,
      });

      if (confidence > (bestMatch?.confidence ?? 0)) {
        bestMatch = { id: slRest.id, confidence };
      }
    }

    if (bestMatch && bestMatch.confidence >= AUTO_MERGE_THRESHOLD) {
      // Merge: copy Seamless data into the DoorDash restaurant record
      await mergeRestaurants(ddRest.id, bestMatch.id, bestMatch.confidence);
      merged++;
    } else if (bestMatch && bestMatch.confidence >= REVIEW_THRESHOLD) {
      console.log(
        `[Dedup] Flagged for review: "${ddRest.canonical_name}" <-> restaurant ${bestMatch.id} (${bestMatch.confidence.toFixed(2)})`
      );
      flagged++;
    }
  }

  console.log(`[Dedup] Complete: ${merged} merged, ${flagged} flagged for review`);
  return { merged, flagged };
}

async function mergeRestaurants(
  primaryId: string,
  secondaryId: string,
  confidence: number
): Promise<void> {
  // Copy platform IDs from secondary into primary
  const secondary = await db.query('SELECT * FROM restaurants WHERE id = $1', [secondaryId]);
  if (secondary.rows.length === 0) return;

  const s = secondary.rows[0];
  await db.query(
    `UPDATE restaurants SET
       seamless_id = COALESCE(seamless_id, $1),
       seamless_url = COALESCE(seamless_url, $2),
       match_confidence = $3
     WHERE id = $4`,
    [s.seamless_id, s.seamless_url, confidence, primaryId]
  );

  // Reassign menu data from secondary to primary
  await db.query(
    'UPDATE menus SET restaurant_id = $1 WHERE restaurant_id = $2',
    [primaryId, secondaryId]
  );
  await db.query(
    'UPDATE menu_items SET restaurant_id = $1 WHERE restaurant_id = $2',
    [primaryId, secondaryId]
  );

  // Delete the secondary record
  await db.query('DELETE FROM restaurants WHERE id = $1', [secondaryId]);
}

async function computeMenuOverlap(restId1: string, restId2: string): Promise<number> {
  const items1 = await db.query(
    'SELECT canonical_name FROM menu_items WHERE restaurant_id = $1',
    [restId1]
  );
  const items2 = await db.query(
    'SELECT canonical_name FROM menu_items WHERE restaurant_id = $2',
    [restId2]
  );

  if (items1.rows.length === 0 || items2.rows.length === 0) return 0;

  const set1 = new Set(items1.rows.map((r) => cleanItemName(r.canonical_name)));
  const set2 = new Set(items2.rows.map((r) => cleanItemName(r.canonical_name)));

  let intersection = 0;
  for (const item of set1) {
    if (set2.has(item)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
