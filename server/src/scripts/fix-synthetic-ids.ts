/**
 * Fix synthetic sl-Menu-* platform_item_ids by looking up real numeric IDs
 * from the Seamless REST API, then backfill modifiers for the fixed items.
 *
 * The DOM scraper sometimes captures items from the "Popular Items" carousel
 * before seeing them in the main menu with real IDs. This script:
 *   1. Finds all SL items with synthetic IDs (sl-* prefix)
 *   2. For each restaurant, fetches the menu via REST API to get real item IDs
 *   3. Matches by name and updates platform_item_id
 *   4. Fetches modifiers for newly-fixed items
 *
 * Usage:
 *   npx tsx src/scripts/fix-synthetic-ids.ts
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { extractSeamlessModifiers, type ModifierGroup } from '../services/modifiers.js';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Normalize name for fuzzy matching */
function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('=== Fix Synthetic Seamless Item IDs ===\n');

  // 1. Find all synthetic-ID items grouped by restaurant
  const { rows: syntheticItems } = await db.query(`
    SELECT mi.id, mi.original_name, mi.platform_item_id, mi.restaurant_id,
           r.seamless_id, r.canonical_name
    FROM menu_items mi
    JOIN restaurants r ON r.id = mi.restaurant_id
    WHERE mi.platform = 'seamless'
      AND mi.platform_item_id LIKE 'sl-%'
      AND r.doordash_id IS NOT NULL AND r.seamless_id IS NOT NULL
      AND (r.platform_status->>'excluded' IS NULL)
    ORDER BY r.canonical_name, mi.original_name
  `);

  console.log(`Found ${syntheticItems.length} items with synthetic IDs\n`);

  // Group by restaurant
  const byRestaurant = new Map<string, typeof syntheticItems>();
  for (const item of syntheticItems) {
    const key = item.restaurant_id;
    if (!byRestaurant.has(key)) byRestaurant.set(key, []);
    byRestaurant.get(key)!.push(item);
  }

  console.log(`Across ${byRestaurant.size} restaurants\n`);

  // 2. Initialize Seamless adapter
  const adapter = new SeamlessAdapter();
  await adapter.initialize({ email: process.env.SEAMLESS_EMAIL || '' });

  let totalFixed = 0;
  let totalModifiers = 0;
  let totalNotFound = 0;
  let ri = 0;

  for (const [restaurantId, items] of byRestaurant) {
    ri++;
    const restName = items[0].canonical_name;
    const seamlessId = items[0].seamless_id;
    console.log(`[${ri}/${byRestaurant.size}] ${restName} (SL ${seamlessId}): ${items.length} synthetic IDs`);

    try {
      // 3. Fetch restaurant menu from API to get real item IDs
      // Use enhanced_feed to get category list, then per-category items
      const categories = await fetchMenuItemIds(adapter, seamlessId);

      if (categories.size === 0) {
        console.log('  No items returned from API — skipping');
        continue;
      }

      console.log(`  API returned ${categories.size} items`);

      // 4. Match synthetic items by name
      let fixed = 0;
      let notFound = 0;
      const fixedItemIds: string[] = [];

      for (const item of items) {
        const normItemName = normName(item.original_name);

        // Try exact match first
        let realId = categories.get(normItemName);

        // Try fuzzy: strip trailing price/size qualifiers
        if (!realId) {
          for (const [apiName, apiId] of categories) {
            if (apiName.includes(normItemName) || normItemName.includes(apiName)) {
              realId = apiId;
              break;
            }
          }
        }

        if (realId) {
          await db.query(
            `UPDATE menu_items SET platform_item_id = $1 WHERE id = $2`,
            [realId, item.id]
          );
          fixed++;
          fixedItemIds.push(item.id);
        } else {
          notFound++;
        }
      }

      totalFixed += fixed;
      totalNotFound += notFound;
      console.log(`  Fixed: ${fixed}, Not found: ${notFound}`);

      // 5. Fetch modifiers for fixed items
      if (fixedItemIds.length > 0) {
        let modCount = 0;
        for (const itemId of fixedItemIds) {
          const { rows } = await db.query(
            `SELECT platform_item_id FROM menu_items WHERE id = $1`,
            [itemId]
          );
          const platformItemId = rows[0]?.platform_item_id;
          if (!platformItemId) continue;

          try {
            const choiceCategories = await adapter.fetchItemModifiers(seamlessId, platformItemId);
            if (choiceCategories && choiceCategories.length > 0) {
              const groups: ModifierGroup[] = extractSeamlessModifiers(choiceCategories);
              await db.query(
                `UPDATE menu_items SET modifier_groups = $1::jsonb WHERE id = $2`,
                [JSON.stringify(groups), itemId]
              );
              if (groups.length > 0) modCount++;
            } else {
              await db.query(
                `UPDATE menu_items SET modifier_groups = '[]'::jsonb WHERE id = $1`,
                [itemId]
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message.substring(0, 80) : String(err);
            // Refresh token on 401
            if (msg.includes('401')) {
              console.log('  Auth token expired — refreshing...');
              try {
                await adapter.refreshTokens();
              } catch { /* ignore */ }
            }
          }
          await sleep(1000 + Math.random() * 500);
        }
        totalModifiers += modCount;
        if (modCount > 0) console.log(`  Fetched modifiers for ${modCount} items`);
      }

    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message.substring(0, 120) : err}`);
    }

    await sleep(2000 + Math.random() * 1000);
  }

  console.log(`\n=== Done ===`);
  console.log(`Fixed IDs: ${totalFixed}/${syntheticItems.length}`);
  console.log(`Not found in API: ${totalNotFound}`);
  console.log(`Modifiers fetched: ${totalModifiers}`);

  await db.pool.end();
  process.exit(0);
}

/**
 * Fetch all menu item names + IDs from a restaurant via the SL REST API.
 * Uses the same endpoints as getMenuFromAPI:
 *   1. /restaurant_gateway/info/volatile/{id}?enhancedFeed=true → category list
 *   2. /restaurant_gateway/feed/{id}/{catId}?task=CATEGORY → items per category
 * Returns Map<normalizedName, platformItemId>.
 */
async function fetchMenuItemIds(
  adapter: SeamlessAdapter,
  restaurantId: string
): Promise<Map<string, string>> {
  const nameToId = new Map<string, string>();
  const skipCategories = ['Category Navigation', 'Search', 'Offers', 'Best Sellers', 'Order Again', 'Similar options nearby'];

  try {
    // Get category list via enhanced_feed
    const feedResp = await (adapter as any).apiCall(
      `/restaurant_gateway/info/volatile/${restaurantId}?orderType=STANDARD&platform=WEB&enhancedFeed=true&weightedItemDataIncluded=true`
    );

    const feed = feedResp?.object?.data?.enhanced_feed || [];
    if (!Array.isArray(feed) || feed.length === 0) return nameToId;

    const menuCategories = feed.filter((f: any) => f.id && f.name && !skipCategories.includes(f.name));

    // Fetch items per category
    for (const cat of menuCategories) {
      try {
        const catResp = await (adapter as any).apiCall(
          `/restaurant_gateway/feed/${restaurantId}/${cat.id}?orderType=STANDARD&platform=WEB&weightedItemDataIncluded=true&task=CATEGORY`
        );

        const content = catResp?.object?.data?.content || [];
        for (const entry of content) {
          const item = entry?.entity;
          if (!item?.item_id || !item?.item_name) continue;
          nameToId.set(normName(item.item_name), String(item.item_id));
        }
      } catch {
        // Skip category on error
      }
      await sleep(500);
    }
  } catch (err) {
    console.warn(`  API menu fetch failed: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
  }

  return nameToId;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
