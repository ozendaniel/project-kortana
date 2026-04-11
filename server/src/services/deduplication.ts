import { db } from '../db/client.js';
import { jaroWinkler, computeMatchConfidence } from '../utils/fuzzyMatch.js';
import { cleanRestaurantName, cleanItemName } from '../utils/nameCleaner.js';
import { haversineDistance } from '../utils/geocode.js';

// --- Constants ---
const AUTO_MERGE_THRESHOLD = 0.88;
const REVIEW_THRESHOLD = 0.60;
const GEO_CUTOFF_METERS = 400;
const NAME_ONLY_MIN_SIMILARITY = 0.85;
const MAX_PREFIX_BLOCK_SIZE = 200;
const GEOHASH_PRECISION = 6; // ~1.2km x 0.6km cells at NYC latitude

// --- Types ---
interface RestaurantRow {
  id: string;
  canonical_name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  cuisine_tags: string[] | null;
  doordash_id: string | null;
  seamless_id: string | null;
}

interface IndexedRestaurant extends RestaurantRow {
  cleanedName: string;
  geohash: string | null;
  normalizedPhone: string | null;
}

interface BlockingIndexes {
  byExactName: Map<string, IndexedRestaurant[]>;
  byGeohash: Map<string, IndexedRestaurant[]>;
  byNamePrefix: Map<string, IndexedRestaurant[]>;
  byPhone: Map<string, IndexedRestaurant[]>;
}

// --- Geohash implementation (no external dependencies) ---
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat: number, lng: number, precision: number): string {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let isLng = true;

  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch |= (1 << (4 - bit)); lngMin = mid; }
      else { lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch |= (1 << (4 - bit)); latMin = mid; }
      else { latMax = mid; }
    }
    isLng = !isLng;
    bit++;
    if (bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

function decodeGeohash(hash: string): { lat: number; lng: number; latErr: number; lngErr: number } {
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let isLng = true;

  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    for (let bit = 4; bit >= 0; bit--) {
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (idx & (1 << bit)) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (idx & (1 << bit)) latMin = mid;
        else latMax = mid;
      }
      isLng = !isLng;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
    latErr: (latMax - latMin) / 2,
    lngErr: (lngMax - lngMin) / 2,
  };
}

function geohashNeighbors(hash: string): string[] {
  const { lat, lng, latErr, lngErr } = decodeGeohash(hash);
  const precision = hash.length;
  const dlat = latErr * 2;
  const dlng = lngErr * 2;

  const neighbors: string[] = [];
  for (const dLat of [-dlat, 0, dlat]) {
    for (const dLng of [-dlng, 0, dlng]) {
      if (dLat === 0 && dLng === 0) continue; // skip center (that's the hash itself)
      neighbors.push(encodeGeohash(lat + dLat, lng + dLng, precision));
    }
  }
  return neighbors;
}

// --- Phone normalization ---
function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10); // last 10 digits (strip country code)
}

// --- Blocking index builder ---
function indexRestaurant(row: RestaurantRow): IndexedRestaurant {
  const cleanedName = cleanRestaurantName(row.canonical_name);
  const hasRealAddress = row.address && row.address !== '' && row.lat && row.lng;
  const geohash = hasRealAddress ? encodeGeohash(row.lat!, row.lng!, GEOHASH_PRECISION) : null;
  const normalizedPhone = normalizePhone(row.phone);
  return { ...row, cleanedName, geohash, normalizedPhone };
}

function buildBlockingIndexes(restaurants: IndexedRestaurant[]): BlockingIndexes {
  const byExactName = new Map<string, IndexedRestaurant[]>();
  const byGeohash = new Map<string, IndexedRestaurant[]>();
  const byNamePrefix = new Map<string, IndexedRestaurant[]>();
  const byPhone = new Map<string, IndexedRestaurant[]>();

  for (const rest of restaurants) {
    // Strategy A: Exact cleaned name
    const nameKey = rest.cleanedName;
    if (!byExactName.has(nameKey)) byExactName.set(nameKey, []);
    byExactName.get(nameKey)!.push(rest);

    // Strategy B: Geohash
    if (rest.geohash) {
      if (!byGeohash.has(rest.geohash)) byGeohash.set(rest.geohash, []);
      byGeohash.get(rest.geohash)!.push(rest);
    }

    // Strategy C: Name prefix (first 3 chars)
    if (nameKey.length >= 3) {
      const prefix = nameKey.substring(0, 3);
      if (!byNamePrefix.has(prefix)) byNamePrefix.set(prefix, []);
      byNamePrefix.get(prefix)!.push(rest);
    }

    // Strategy D: Phone
    if (rest.normalizedPhone) {
      if (!byPhone.has(rest.normalizedPhone)) byPhone.set(rest.normalizedPhone, []);
      byPhone.get(rest.normalizedPhone)!.push(rest);
    }
  }

  return { byExactName, byGeohash, byNamePrefix, byPhone };
}

// --- Candidate gathering ---
function gatherCandidates(
  ddRest: IndexedRestaurant,
  indexes: BlockingIndexes,
  mergedSlIds: Set<string>,
): IndexedRestaurant[] {
  const candidateIds = new Set<string>();
  const candidates: IndexedRestaurant[] = [];

  function addCandidates(block: IndexedRestaurant[] | undefined) {
    if (!block) return;
    for (const sl of block) {
      if (mergedSlIds.has(sl.id) || candidateIds.has(sl.id)) continue;
      candidateIds.add(sl.id);
      candidates.push(sl);
    }
  }

  // Strategy A: Exact cleaned name
  addCandidates(indexes.byExactName.get(ddRest.cleanedName));

  // Strategy B: Geohash + 8 neighbors
  if (ddRest.geohash) {
    addCandidates(indexes.byGeohash.get(ddRest.geohash));
    for (const neighbor of geohashNeighbors(ddRest.geohash)) {
      addCandidates(indexes.byGeohash.get(neighbor));
    }
  }

  // Strategy C: Name prefix (skip oversized blocks)
  if (ddRest.cleanedName.length >= 3) {
    const prefix = ddRest.cleanedName.substring(0, 3);
    const block = indexes.byNamePrefix.get(prefix);
    if (block && block.length <= MAX_PREFIX_BLOCK_SIZE) {
      addCandidates(block);
    }
  }

  // Strategy D: Phone
  if (ddRest.normalizedPhone) {
    addCandidates(indexes.byPhone.get(ddRest.normalizedPhone));
  }

  return candidates;
}

// --- Scoring ---
function scoreCandidate(
  ddRest: IndexedRestaurant,
  slRest: IndexedRestaurant,
  ddHasGeo: boolean,
): number {
  if (ddHasGeo && slRest.lat && slRest.lng) {
    // Geo-based scoring
    const distance = haversineDistance(ddRest.lat!, ddRest.lng!, slRest.lat, slRest.lng);
    if (distance > GEO_CUTOFF_METERS) return 0;

    const nameSimilarity = jaroWinkler(ddRest.cleanedName, slRest.cleanedName);
    const phoneMatch = !!(ddRest.normalizedPhone && slRest.normalizedPhone
      && ddRest.normalizedPhone === slRest.normalizedPhone);
    const menuOverlap = computeMenuOverlap(ddRest.id, slRest.id);

    return computeMatchConfidence({ nameSimilarity, distanceMeters: distance, phoneMatch, menuOverlap });
  }

  // Name-only scoring (no reliable geo data)
  const nameSimilarity = jaroWinkler(ddRest.cleanedName, slRest.cleanedName);
  if (nameSimilarity < NAME_ONLY_MIN_SIMILARITY) return 0;

  // Cuisine overlap as secondary signal
  const ddCuisines = new Set((ddRest.cuisine_tags || []).map(c => c.toLowerCase()));
  const slCuisines = new Set((slRest.cuisine_tags || []).map(c => c.toLowerCase()));
  let cuisineOverlap = 0;
  if (ddCuisines.size > 0 && slCuisines.size > 0) {
    let intersection = 0;
    for (const c of ddCuisines) {
      if (slCuisines.has(c)) intersection++;
    }
    cuisineOverlap = intersection / Math.min(ddCuisines.size, slCuisines.size);
  }

  // Heuristic confidence tiers (same as original)
  if (nameSimilarity >= 0.95) return 0.85;
  if (nameSimilarity >= 0.92 && cuisineOverlap >= 0.5) return 0.80;
  if (nameSimilarity >= 0.85) return 0.70;
  return 0.50;
}

// --- Menu cache (preserved from original) ---
let menuCache: Map<string, Set<string>> | null = null;

async function loadMenuCache(): Promise<Map<string, Set<string>>> {
  if (menuCache) return menuCache;
  console.log('[Dedup] Loading menu items into memory...');
  const result = await db.query('SELECT restaurant_id, canonical_name FROM menu_items');
  menuCache = new Map();
  for (const row of result.rows) {
    if (!menuCache.has(row.restaurant_id)) {
      menuCache.set(row.restaurant_id, new Set());
    }
    menuCache.get(row.restaurant_id)!.add(cleanItemName(row.canonical_name));
  }
  console.log(`[Dedup] Loaded menu items for ${menuCache.size} restaurants`);
  return menuCache;
}

function computeMenuOverlap(restId1: string, restId2: string): number {
  if (!menuCache) return 0;
  const set1 = menuCache.get(restId1);
  const set2 = menuCache.get(restId2);
  if (!set1 || !set2 || set1.size === 0 || set2.size === 0) return 0;

  let intersection = 0;
  for (const item of set1) {
    if (set2.has(item)) intersection++;
  }
  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Merge (preserved from original) ---
async function mergeRestaurants(
  primaryId: string,
  secondaryId: string,
  confidence: number
): Promise<void> {
  const secondary = await db.query('SELECT * FROM restaurants WHERE id = $1', [secondaryId]);
  if (secondary.rows.length === 0) return;

  const s = secondary.rows[0];

  // Reassign menu data from secondary to primary
  await db.query('UPDATE menus SET restaurant_id = $1 WHERE restaurant_id = $2', [primaryId, secondaryId]);
  await db.query('UPDATE menu_items SET restaurant_id = $1 WHERE restaurant_id = $2', [primaryId, secondaryId]);

  // Delete secondary BEFORE updating primary to avoid unique constraint violation
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

// --- Main export ---
export async function deduplicateRestaurants(options?: { dryRun?: boolean }): Promise<{
  merged: number;
  flagged: number;
}> {
  const dryRun = options?.dryRun ?? false;
  console.time('[Dedup] Total');

  // Phase 0: Load data
  await loadMenuCache();

  const ddResult = await db.query(
    `SELECT id, canonical_name, address, lat, lng, phone, cuisine_tags, doordash_id, seamless_id
     FROM restaurants
     WHERE doordash_id IS NOT NULL AND seamless_id IS NULL`
  );
  const slResult = await db.query(
    `SELECT id, canonical_name, address, lat, lng, phone, cuisine_tags, doordash_id, seamless_id
     FROM restaurants
     WHERE seamless_id IS NOT NULL AND doordash_id IS NULL`
  );

  // Index all restaurants (pre-compute cleaned names, geohashes, phones)
  const ddAll = ddResult.rows.map(indexRestaurant);
  const slAll = slResult.rows.map(indexRestaurant);

  // Separate DD into has-address and no-address (process addresses first for higher confidence)
  const ddWithAddr = ddAll.filter(r => r.address && r.address !== '' && r.lat && r.lng);
  const ddNoAddr = ddAll.filter(r => !r.address || r.address === '');

  console.log(`[Dedup] Loaded ${ddAll.length} DD restaurants (${ddWithAddr.length} with address, ${ddNoAddr.length} without)`);
  console.log(`[Dedup] Loaded ${slAll.length} SL restaurants`);

  // Phase 1: Build blocking indexes on SL restaurants
  const indexes = buildBlockingIndexes(slAll);
  console.log(`[Dedup] Built indexes: exactName=${indexes.byExactName.size} keys, geohash=${indexes.byGeohash.size} cells, prefix=${indexes.byNamePrefix.size} keys, phone=${indexes.byPhone.size} keys`);

  // Phase 2: Match
  const mergedSlIds = new Set<string>();
  let merged = 0;
  let flagged = 0;
  let totalComparisons = 0;

  function processDD(ddRestaurants: IndexedRestaurant[], label: string) {
    for (const ddRest of ddRestaurants) {
      const ddHasGeo = !!(ddRest.address && ddRest.address !== '' && ddRest.lat && ddRest.lng);
      const candidates = gatherCandidates(ddRest, indexes, mergedSlIds);
      totalComparisons += candidates.length;

      let bestMatch: { id: string; confidence: number; name: string } | null = null;

      for (const slRest of candidates) {
        const confidence = scoreCandidate(ddRest, slRest, ddHasGeo);
        if (confidence > (bestMatch?.confidence ?? 0)) {
          bestMatch = { id: slRest.id, confidence, name: slRest.canonical_name };
        }
      }

      if (bestMatch && bestMatch.confidence >= AUTO_MERGE_THRESHOLD) {
        if (dryRun) {
          console.log(`[Dedup] Would merge: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`);
        }
        mergedSlIds.add(bestMatch.id);
        merged++;
      } else if (bestMatch && bestMatch.confidence >= REVIEW_THRESHOLD) {
        console.log(`[Dedup] ${label} flagged: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`);
        flagged++;
      }
    }
  }

  // Process DD with addresses first (higher confidence geo matches consume SL restaurants)
  processDD(ddWithAddr, 'Geo');
  processDD(ddNoAddr, 'Name-only');

  console.log(`[Dedup] Total comparisons: ${totalComparisons.toLocaleString()} (vs ${(ddAll.length * slAll.length).toLocaleString()} brute force = ${Math.round(ddAll.length * slAll.length / Math.max(totalComparisons, 1))}x reduction)`);

  // Phase 3: Apply merges (skip in dry-run)
  if (!dryRun && merged > 0) {
    console.log(`[Dedup] Applying ${merged} merges...`);

    // Re-run to actually merge (need the match pairs again)
    const mergedSlIds2 = new Set<string>();

    async function applyMerges(ddRestaurants: IndexedRestaurant[]) {
      for (const ddRest of ddRestaurants) {
        const ddHasGeo = !!(ddRest.address && ddRest.address !== '' && ddRest.lat && ddRest.lng);
        const candidates = gatherCandidates(ddRest, indexes, mergedSlIds2);

        let bestMatch: { id: string; confidence: number; name: string } | null = null;
        for (const slRest of candidates) {
          const confidence = scoreCandidate(ddRest, slRest, ddHasGeo);
          if (confidence > (bestMatch?.confidence ?? 0)) {
            bestMatch = { id: slRest.id, confidence, name: slRest.canonical_name };
          }
        }

        if (bestMatch && bestMatch.confidence >= AUTO_MERGE_THRESHOLD) {
          await mergeRestaurants(ddRest.id, bestMatch.id, bestMatch.confidence);
          mergedSlIds2.add(bestMatch.id);
          console.log(`[Dedup] Merged: "${ddRest.canonical_name}" <-> "${bestMatch.name}" (${bestMatch.confidence.toFixed(2)})`);
        }
      }
    }

    await applyMerges(ddWithAddr);
    await applyMerges(ddNoAddr);
  }

  console.log(`[Dedup] Complete: ${merged} merged, ${flagged} flagged for review`);
  console.timeEnd('[Dedup] Total');
  return { merged, flagged };
}
