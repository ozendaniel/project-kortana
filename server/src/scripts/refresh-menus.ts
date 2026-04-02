/**
 * Refresh menus for a specific restaurant from live adapters.
 * Fetches full menus from DoorDash and Seamless, upserts to DB, runs matching.
 *
 * Usage: npx tsx src/scripts/refresh-menus.ts [restaurantId]
 * If no ID given, refreshes all restaurants with both platform IDs.
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { matchMenuItems } from '../services/matching.js';
import { upsertMenu } from '../services/menu-upsert.js';
import type { PlatformAdapter } from '../adapters/types.js';

async function main() {
  const targetId = process.argv[2];

  // Get restaurants to refresh
  let query = `SELECT id, canonical_name, doordash_id, seamless_id FROM restaurants WHERE doordash_id IS NOT NULL AND seamless_id IS NOT NULL`;
  const params: string[] = [];
  if (targetId) {
    query += ` AND id = $1`;
    params.push(targetId);
  }
  const restaurants = await db.query(query, params);

  if (restaurants.rows.length === 0) {
    console.log('No restaurants found with both platform IDs.');
    process.exit(0);
  }

  console.log(`Refreshing menus for ${restaurants.rows.length} restaurant(s)...\n`);

  // Initialize adapters
  const adapters: Record<string, PlatformAdapter> = {};

  if (process.env.DOORDASH_EMAIL) {
    console.log('Initializing DoorDash adapter...');
    const dd = new DoorDashAdapter();
    await dd.initialize({ email: process.env.DOORDASH_EMAIL });
    adapters.doordash = dd;
    console.log('DoorDash ready.\n');
  }

  // Wait before Seamless to avoid DoorDash rate limits affecting it
  await new Promise(resolve => setTimeout(resolve, 3000));

  if (process.env.SEAMLESS_EMAIL) {
    console.log('Initializing Seamless adapter...');
    const sl = new SeamlessAdapter();
    await sl.initialize({ email: process.env.SEAMLESS_EMAIL, password: process.env.SEAMLESS_PASSWORD });
    adapters.seamless = sl;
    console.log('Seamless ready.\n');
  }

  for (const rest of restaurants.rows) {
    console.log(`\n=== ${rest.canonical_name} (${rest.id}) ===`);

    // Fetch DoorDash menu
    if (adapters.doordash && rest.doordash_id) {
      try {
        console.log(`  DoorDash (store ${rest.doordash_id}): fetching menu...`);
        const menu = await adapters.doordash.getMenu(rest.doordash_id);
        const count = await upsertMenu(rest.id, 'doordash', menu);
        console.log(`  DoorDash: ${count} items saved`);
      } catch (err) {
        console.error(`  DoorDash error:`, err instanceof Error ? err.message : err);
      }

      // Rate limit gap before Seamless
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Fetch Seamless menu
    if (adapters.seamless && rest.seamless_id) {
      try {
        console.log(`  Seamless (store ${rest.seamless_id}): fetching menu...`);
        const menu = await adapters.seamless.getMenu(rest.seamless_id);
        const count = await upsertMenu(rest.id, 'seamless', menu);
        console.log(`  Seamless: ${count} items saved`);
      } catch (err) {
        console.error(`  Seamless error:`, err instanceof Error ? err.message : err);
      }
    }

    // Run cross-platform matching
    console.log(`  Running item matching...`);
    const result = await matchMenuItems(rest.id);
    console.log(`  Matched: ${result.matched}, Unmatched: ${result.unmatched}`);
  }

  // Final counts
  const counts = await db.query(
    `SELECT platform, COUNT(*) as count FROM menu_items GROUP BY platform`
  );
  const matchCount = await db.query(
    `SELECT COUNT(*) as count FROM menu_items WHERE matched_item_id IS NOT NULL`
  );
  console.log('\n=== Final DB state ===');
  for (const row of counts.rows) {
    console.log(`  ${row.platform}: ${row.count} items`);
  }
  console.log(`  Cross-matched: ${matchCount.rows[0].count} items`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
