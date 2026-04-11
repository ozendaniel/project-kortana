/**
 * Run cross-platform menu item matching on all matched restaurants with menus on both platforms.
 *
 * Usage:
 *   npx tsx src/scripts/match-all-restaurants.ts               # All ready restaurants
 *   npx tsx src/scripts/match-all-restaurants.ts --resume      # Skip restaurants that already have matches
 *   npx tsx src/scripts/match-all-restaurants.ts --limit 10    # First 10 only
 *   npx tsx src/scripts/match-all-restaurants.ts --restaurant-id X
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { matchMenuItems, validateMatches } from '../services/matching.js';

const args = process.argv.slice(2);
const resume = args.includes('--resume');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const ridIdx = args.indexOf('--restaurant-id');
const singleRestaurantId = ridIdx !== -1 ? args[ridIdx + 1] : null;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface Target {
  id: string;
  canonical_name: string;
  dd_items: number;
  sl_items: number;
  has_matches: boolean;
}

async function main() {
  let conditions = `r.doordash_id IS NOT NULL AND r.seamless_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform='doordash')
    AND EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform='seamless')`;
  const params: any[] = [];

  if (singleRestaurantId) {
    conditions += ` AND r.id = $1`;
    params.push(singleRestaurantId);
  }

  const sql = `
    SELECT r.id, r.canonical_name,
      (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform='doordash') AS dd_items,
      (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform='seamless') AS sl_items,
      EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.matched_item_id IS NOT NULL) AS has_matches
    FROM restaurants r
    WHERE ${conditions}
    ORDER BY (SELECT COUNT(*) FROM menu_items mi WHERE mi.restaurant_id = r.id) ASC
  `;

  const result = await db.query(sql, params);
  let targets: Target[] = result.rows;

  if (resume) {
    const before = targets.length;
    targets = targets.filter(t => !t.has_matches);
    console.log(`[Match-All] Resume: ${before - targets.length} already matched, ${targets.length} remaining`);
  }

  if (limit > 0) {
    targets = targets.slice(0, limit);
  }

  console.log(`[Match-All] Processing ${targets.length} restaurants`);
  console.log(`[Match-All] Starting at ${new Date().toISOString()}\n`);

  const startTime = Date.now();
  let totalMatched = 0;
  let totalUnmatched = 0;
  let restaurantsOK = 0;
  let restaurantsFailed = 0;
  let restaurantsLowMatch = 0;
  const lowMatchRestaurants: Array<{ name: string; rate: number }> = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const progress = `[${i + 1}/${targets.length}]`;
    const total = t.dd_items + t.sl_items;

    try {
      const restStart = Date.now();
      const result = await matchMenuItems(t.id);
      const elapsed = ((Date.now() - restStart) / 1000).toFixed(1);

      const rate = 'matchRate' in result ? (result as any).matchRate : 0;
      const pct = (rate * 100).toFixed(0);
      const marker = rate < 0.3 ? ' ⚠' : '';

      console.log(
        `${progress} ${t.canonical_name.padEnd(40).substring(0, 40)} ` +
        `DD:${String(t.dd_items).padStart(3)} SL:${String(t.sl_items).padStart(3)} ` +
        `→ ${result.matched} matched (${pct}%) — ${elapsed}s${marker}`
      );

      totalMatched += result.matched;
      totalUnmatched += result.unmatched;
      restaurantsOK++;

      if (rate < 0.3) {
        restaurantsLowMatch++;
        lowMatchRestaurants.push({ name: t.canonical_name, rate });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${progress} ${t.canonical_name}: FAILED — ${msg.substring(0, 120)}`);
      restaurantsFailed++;
    }

    // Progress snapshot every 25 restaurants
    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const rate = ((i + 1) / ((Date.now() - startTime) / 1000 / 60)).toFixed(1);
      console.log(`\n--- Progress: ${i + 1}/${targets.length} (${elapsed} min elapsed, ${rate} rest/min) ---\n`);
    }

    // Light pacing to avoid overwhelming the LLM API
    await sleep(500);
  }

  // Final summary
  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log('=== Item Matching Complete ===');
  console.log('='.repeat(70));
  console.log(`Time elapsed:         ${totalMin} min`);
  console.log(`Restaurants OK:       ${restaurantsOK}`);
  console.log(`Restaurants failed:   ${restaurantsFailed}`);
  console.log(`Low match rate (<30%): ${restaurantsLowMatch}`);
  console.log(`Total items matched:  ${totalMatched}`);
  console.log(`Total items unmatched: ${totalUnmatched}`);
  if (totalMatched + totalUnmatched > 0) {
    console.log(`Overall match rate:   ${((totalMatched / (totalMatched + totalUnmatched)) * 100).toFixed(1)}%`);
  }

  if (lowMatchRestaurants.length > 0) {
    console.log('\nLow-match restaurants (first 20):');
    for (const r of lowMatchRestaurants.slice(0, 20)) {
      console.log(`  ${(r.rate * 100).toFixed(0).padStart(3)}%  ${r.name}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[Match-All] Fatal error:', err);
  process.exit(1);
});
