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
export async function deduplicateRestaurants(options?: { dryRun?: boolean }): Promise<{
  merged: number;
  flagged: number;
}> {
  const dryRun = options?.dryRun ?? false;
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
      if (dryRun) {
        console.log(`[Dedup] Would merge: "${ddRest.canonical_name}" <-> restaurant ${bestMatch.id} (${bestMatch.confidence.toFixed(2)})`);
      } else {
        await mergeRestaurants(ddRest.id, bestMatch.id, bestMatch.confidence);
      }
      merged++;
    } else if (bestMatch && bestMatch.confidence >= REVIEW_THRESHOLD) {
      console.log(
        `[Dedup] Flagged for review: "${ddRest.canonical_name}" <-> restaurant ${bestMatch.id} (${bestMatch.confidence.toFixed(2)})`
      );
      flagged++;
    }
  }

  // Pass 2: Name-only matching for DoorDash restaurants without real addresses.
  // These have approximate lat/lng from the search grid point, so geo-based matching
  // would reject valid matches. Use high name similarity + cuisine overlap instead.
  const unmatchedDDNoAddr = await db.query(
    `SELECT id, canonical_name, cuisine_tags, doordash_id
     FROM restaurants
     WHERE doordash_id IS NOT NULL AND seamless_id IS NULL
       AND (address IS NULL OR address = '')`
  );

  // Refresh Seamless candidates (some may have been consumed by Pass 1)
  const remainingSLCandidates = await db.query(
    `SELECT id, canonical_name, cuisine_tags, seamless_id
     FROM restaurants
     WHERE seamless_id IS NOT NULL AND doordash_id IS NULL`
  );

  for (const ddRest of unmatchedDDNoAddr.rows) {
    const cleanDD = cleanRestaurantName(ddRest.canonical_name);
    let bestMatch: { id: string; confidence: number; name: string } | null = null;

    for (const slRest of remainingSLCandidates.rows) {
      const cleanSL = cleanRestaurantName(slRest.canonical_name);
      const nameSimilarity = jaroWinkler(cleanDD, cleanSL);

      if (nameSimilarity < 0.88) continue;

      // Check cuisine overlap as additional signal
      const ddCuisines = new Set((ddRest.cuisine_tags || []).map((c: string) => c.toLowerCase()));
      const slCuisines = new Set((slRest.cuisine_tags || []).map((c: string) => c.toLowerCase()));
      let cuisineOverlap = 0;
      if (ddCuisines.size > 0 && slCuisines.size > 0) {
        let intersection = 0;
        for (const c of ddCuisines) {
          if (slCuisines.has(c)) intersection++;
        }
        cuisineOverlap = intersection / Math.min(ddCuisines.size, slCuisines.size);
      }

      // Require either very high name similarity or name + cuisine match
      const confidence = nameSimilarity >= 0.95 ? 0.85
        : (cuisineOverlap >= 0.3 ? 0.80 : 0.65);

      if (confidence > (bestMatch?.confidence ?? 0)) {
        bestMatch = { id: slRest.id, confidence, name: slRest.canonical_name };
      }
    }

    if (bestMatch && bestMatch.confidence >= AUTO_MERGE_THRESHOLD) {
      if (dryRun) {
        console.log(`[Dedup] Would name-only merge: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`);
      } else {
        await mergeRestaurants(ddRest.id, bestMatch.id, bestMatch.confidence);
        console.log(`[Dedup] Name-only merge: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`);
      }
      merged++;
    } else if (bestMatch && bestMatch.confidence >= REVIEW_THRESHOLD) {
      console.log(
        `[Dedup] Name-only flagged: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`
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

  // Reassign menu data from secondary to primary
  await db.query(
    'UPDATE menus SET restaurant_id = $1 WHERE restaurant_id = $2',
    [primaryId, secondaryId]
  );
  await db.query(
    'UPDATE menu_items SET restaurant_id = $1 WHERE restaurant_id = $2',
    [primaryId, secondaryId]
  );

  // Delete the secondary record BEFORE updating primary to avoid unique constraint
  // violation on seamless_id (both records can't have the same value simultaneously)
  await db.query('DELETE FROM restaurants WHERE id = $1', [secondaryId]);

  await db.query(
    `UPDATE restaurants SET
       seamless_id = COALESCE(seamless_id, $1),
       seamless_url = COALESCE(seamless_url, $2),
       match_confidence = $3
     WHERE id = $4`,
    [s.seamless_id, s.seamless_url, confidence, primaryId]
  );
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
