/**
 * Bulk discover Seamless restaurants across Manhattan via grid search.
 *
 * Usage: npx tsx src/scripts/discover-seamless.ts
 * Must run with server stopped (uses CDP port 9223).
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { cleanRestaurantName } from '../utils/nameCleaner.js';

// Manhattan grid: ~2km spacing for overlapping coverage
// Lat 40.700–40.820, Lng -74.020 to -73.930
const GRID_POINTS: Array<{ lat: number; lng: number; label: string }> = [];

const LAT_START = 40.700;
const LAT_END = 40.820;
const LAT_STEP = 0.018; // ~2km

const LNG_START = -74.020;
const LNG_END = -73.930;
const LNG_STEP = 0.022; // ~2km at NYC latitude

for (let lat = LAT_START; lat <= LAT_END; lat += LAT_STEP) {
  for (let lng = LNG_START; lng <= LNG_END; lng += LNG_STEP) {
    GRID_POINTS.push({
      lat: Math.round(lat * 1000000) / 1000000,
      lng: Math.round(lng * 1000000) / 1000000,
      label: `(${lat.toFixed(3)}, ${lng.toFixed(3)})`,
    });
  }
}

async function upsertRestaurant(rest: {
  platformId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  cuisines: string[];
  rating?: number;
  deliveryTime?: string;
  deliveryFee?: number;
  imageUrl?: string;
  platformUrl: string;
}): Promise<'inserted' | 'updated'> {
  const cleanName = cleanRestaurantName(rest.name);

  const result = await db.query(
    `INSERT INTO restaurants (canonical_name, address, lat, lng, cuisine_tags, seamless_id, seamless_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (seamless_id) WHERE seamless_id IS NOT NULL
     DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       address = EXCLUDED.address,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       cuisine_tags = EXCLUDED.cuisine_tags,
       seamless_url = EXCLUDED.seamless_url
     RETURNING (xmax = 0) AS is_insert`,
    [cleanName, rest.address, rest.lat, rest.lng, rest.cuisines, rest.platformId, rest.platformUrl]
  );

  return result.rows[0]?.is_insert ? 'inserted' : 'updated';
}

async function main() {
  console.log(`[Discover-Seamless] Starting grid search with ${GRID_POINTS.length} points`);
  console.log(`[Discover-Seamless] Grid: lat ${LAT_START}–${LAT_END}, lng ${LNG_START}–${LNG_END}`);

  const email = process.env.SEAMLESS_EMAIL;
  if (!email) {
    console.error('[Discover-Seamless] SEAMLESS_EMAIL not set in .env');
    process.exit(1);
  }

  const adapter = new SeamlessAdapter();
  await adapter.initialize({ email, password: process.env.SEAMLESS_PASSWORD });

  if (adapter.getStatus() !== 'authenticated') {
    console.error('[Discover-Seamless] Not authenticated. Log in via Settings page first.');
    process.exit(1);
  }

  let totalFound = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let failedPoints = 0;
  const seenIds = new Set<string>();

  for (let i = 0; i < GRID_POINTS.length; i++) {
    const point = GRID_POINTS[i];
    const progress = `[${i + 1}/${GRID_POINTS.length}]`;

    try {
      const restaurants = await adapter.searchRestaurants({
        address: '',
        lat: point.lat,
        lng: point.lng,
      });

      let pointNew = 0;
      let pointUpdated = 0;

      for (const rest of restaurants) {
        if (seenIds.has(rest.platformId)) continue;
        seenIds.add(rest.platformId);

        const action = await upsertRestaurant(rest);
        if (action === 'inserted') {
          pointNew++;
          totalInserted++;
        } else {
          pointUpdated++;
          totalUpdated++;
        }
        totalFound++;
      }

      console.log(
        `${progress} ${point.label}: ${restaurants.length} results, ${pointNew} new, ${pointUpdated} updated (${seenIds.size} unique total)`
      );
    } catch (err) {
      console.error(`${progress} ${point.label}: FAILED -`, err instanceof Error ? err.message : err);
      failedPoints++;
    }

    // Rate limit: 3s + random jitter
    if (i < GRID_POINTS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 1500));
    }
  }

  // Final stats
  const dbCount = await db.query('SELECT COUNT(*) FROM restaurants WHERE seamless_id IS NOT NULL');
  console.log('\n=== Discovery Complete ===');
  console.log(`Grid points: ${GRID_POINTS.length} (${failedPoints} failed)`);
  console.log(`Unique restaurants found: ${seenIds.size}`);
  console.log(`New inserted: ${totalInserted}`);
  console.log(`Updated: ${totalUpdated}`);
  console.log(`Total Seamless restaurants in DB: ${dbCount.rows[0].count}`);

  process.exit(0);
}

main().catch(err => {
  console.error('[Discover-Seamless] Fatal error:', err);
  process.exit(1);
});
