/**
 * Backfill modifier_groups on existing Seamless menu_items
 * by fetching /restaurants/{id}/menu_items/{item_id} for each item.
 *
 * Much faster than DD backfill — REST API calls via page.evaluate(fetch()),
 * no page navigation needed. Each call returns choice_category_list which
 * is parsed into our normalized ModifierGroup[] format.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-sl-modifiers.ts                    # All matched restaurants
 *   npx tsx src/scripts/backfill-sl-modifiers.ts --restaurant-id X  # Single restaurant
 *   npx tsx src/scripts/backfill-sl-modifiers.ts --limit 10
 *   npx tsx src/scripts/backfill-sl-modifiers.ts --resume           # Skip items that already have modifier_groups
 *
 * Can run simultaneously with DD backfill (uses port 9223, DD uses 9224).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { extractSeamlessModifiers, type ModifierGroup } from '../services/modifiers.js';
import { acquireLock, releaseLock } from '../utils/process-lock.js';

const args = process.argv.slice(2);
const ridIdx = args.indexOf('--restaurant-id');
const singleRid = ridIdx !== -1 ? args[ridIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const resume = args.includes('--resume');
const allRestaurants = args.includes('--all');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== Backfill Seamless modifier_groups ===\n');

  // Acquire lock so server doesn't try to grab Seamless Chrome
  try {
    await acquireLock('seamless-populate', { script: 'backfill-sl-modifiers' });
  } catch {
    console.error('Could not acquire seamless-populate lock. Is another SL script running?');
    process.exit(1);
  }

  // Target: matched restaurants with SL menu items
  const conditions: string[] = [
    'r.seamless_id IS NOT NULL',
    `(r.platform_status->>'excluded' IS NULL)`,
    `EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform = 'seamless')`,
  ];
  if (!allRestaurants) {
    conditions.push('r.doordash_id IS NOT NULL');
  }
  // Resume mode: skip restaurants where ALL real SL items already have modifier_groups set
  if (resume) {
    conditions.push(
      `EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform = 'seamless' AND mi.modifier_groups IS NULL AND mi.platform_item_id NOT LIKE 'sl-%')`
    );
  }
  const params: unknown[] = [];
  if (singleRid) {
    params.push(singleRid);
    conditions.push(`r.id = $${params.length}`);
  }

  let q = `SELECT r.id, r.canonical_name, r.seamless_id
    FROM restaurants r
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.canonical_name`;
  if (limit > 0) q += ` LIMIT ${limit}`;

  const { rows: restaurants } = await db.query(q, params);
  console.log(`Target: ${restaurants.length} ${allRestaurants ? 'total' : 'matched'} restaurants\n`);

  // Initialize Seamless adapter (connects to existing Chrome on port 9223)
  const adapter = new SeamlessAdapter();
  try {
    await adapter.initialize({ email: process.env.SEAMLESS_EMAIL || '' });
  } catch (err) {
    console.error('Failed to initialize Seamless adapter:', err);
    process.exit(1);
  }

  let totalRestaurants = 0;
  let totalItems = 0;
  let totalWithModifiers = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let ri = 0; ri < restaurants.length; ri++) {
    const rest = restaurants[ri];
    const progress = `[${ri + 1}/${restaurants.length}]`;

    // Get SL menu items for this restaurant
    const resumeFilter = resume
      ? `AND (mi.modifier_groups IS NULL OR mi.modifier_groups::text = 'null')`
      : '';

    const itemsResult = await db.query(
      `SELECT mi.id, mi.platform_item_id, mi.original_name
       FROM menu_items mi
       WHERE mi.restaurant_id = $1 AND mi.platform = 'seamless'
         AND mi.platform_item_id IS NOT NULL
         AND mi.platform_item_id NOT LIKE 'sl-%'
         ${resumeFilter}
       ORDER BY mi.original_name`,
      [rest.id]
    );

    const items = itemsResult.rows;
    if (items.length === 0) {
      console.log(`${progress} ${rest.canonical_name}: no items to process (${resume ? 'all done' : 'no SL items'})`);
      continue;
    }

    console.log(`${progress} ${rest.canonical_name}: ${items.length} items to fetch modifiers`);
    let restModCount = 0;
    let consecutive401s = 0;
    let simpleRefreshAttempts = 0;

    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];
      try {
        const choiceCategories = await adapter.fetchItemModifiers(rest.seamless_id, item.platform_item_id);

        consecutive401s = 0; // Reset on success
        simpleRefreshAttempts = 0;

        if (!choiceCategories || choiceCategories.length === 0) {
          // No modifiers — store empty array to mark as processed
          await db.query(
            `UPDATE menu_items SET modifier_groups = '[]'::jsonb WHERE id = $1`,
            [item.id]
          );
          totalItems++;
          continue;
        }

        const groups: ModifierGroup[] = extractSeamlessModifiers(choiceCategories);

        await db.query(
          `UPDATE menu_items SET modifier_groups = $1::jsonb WHERE id = $2`,
          [JSON.stringify(groups), item.id]
        );

        totalItems++;
        if (groups.length > 0) {
          totalWithModifiers++;
          restModCount++;
        }

        // Log every 50 items
        if ((ii + 1) % 50 === 0) {
          console.log(`  ... ${ii + 1}/${items.length} items processed`);
        }
      } catch (err) {
        totalErrors++;
        const msg = err instanceof Error ? err.message.substring(0, 80) : String(err);

        // Detect auth expiration: 401 errors on real numeric IDs
        if (msg.includes('401') && /^\d+$/.test(item.platform_item_id)) {
          consecutive401s++;
          if (consecutive401s >= 3) {
            if (simpleRefreshAttempts < 2) {
              // First 2 attempts: re-read token from localStorage
              simpleRefreshAttempts++;
              console.log(`  Auth token expired — simple refresh attempt ${simpleRefreshAttempts}...`);
              try {
                await adapter.refreshTokens();
                consecutive401s = 0;
                ii--;
                await sleep(2000);
                continue;
              } catch { /* fall through to force refresh */ }
            }
            // Simple refresh didn't help — force-navigate to seamless.com
            console.log('  Simple refresh ineffective — force-refreshing via page navigation...');
            try {
              await adapter.forceRefreshSession();
              consecutive401s = 0;
              simpleRefreshAttempts = 0;
              console.log('  Session force-refreshed. Retrying...');
              ii--;
              await sleep(5000);
              continue;
            } catch (refreshErr) {
              console.error('  Force-refresh failed. Skipping rest of this restaurant.');
              break;
            }
          }
        }

        // Log but continue — don't let one item kill the whole run
        if (totalErrors <= 10 || totalErrors % 50 === 0) {
          console.warn(`  Error on ${item.original_name} (${item.platform_item_id}): ${msg}`);
        }
      }

      // Rate limit: 1-2s between API calls
      await sleep(1000 + Math.random() * 1000);
    }

    // Mark any remaining NULL items as [] so this restaurant is skipped on future --resume
    await db.query(
      `UPDATE menu_items SET modifier_groups = '[]'::jsonb
       WHERE restaurant_id = $1 AND platform = 'seamless' AND modifier_groups IS NULL`,
      [rest.id]
    );

    totalRestaurants++;
    console.log(`  Done: ${restModCount}/${items.length} items have modifiers`);

    // Brief pause between restaurants
    await sleep(2000 + Math.random() * 1000);
  }

  console.log(`\n=== Backfill complete ===`);
  console.log(`Restaurants: ${totalRestaurants}`);
  console.log(`Items processed: ${totalItems}`);
  console.log(`Items with modifiers: ${totalWithModifiers}`);
  console.log(`Skipped (already done): ${totalSkipped}`);
  console.log(`Errors: ${totalErrors}`);

  releaseLock('seamless-populate');
  await db.pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  releaseLock('seamless-populate');
  process.exit(1);
});
