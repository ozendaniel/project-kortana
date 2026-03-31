import cron from 'node-cron';
import { db } from '../db/client.js';
import type { PlatformAdapter } from '../adapters/types.js';
import { cleanRestaurantName } from '../utils/nameCleaner.js';
import { deduplicateRestaurants } from './deduplication.js';
import { matchMenuItems } from './matching.js';

const RATE_LIMIT_MIN_MS = 1500;
const RATE_LIMIT_MAX_MS = 3500;

function randomDelay(): Promise<void> {
  const ms = RATE_LIMIT_MIN_MS + Math.random() * (RATE_LIMIT_MAX_MS - RATE_LIMIT_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Schedule the daily sync job to run at 3:00 AM ET.
 */
export function scheduleDailySync(adapters: Map<string, PlatformAdapter>): void {
  // 3:00 AM ET (America/New_York)
  cron.schedule(
    '0 3 * * *',
    async () => {
      console.log('[Sync] Starting daily sync...');
      try {
        await runSync(adapters);
      } catch (err) {
        console.error('[Sync] Daily sync failed:', err);
      }
    },
    { timezone: 'America/New_York' }
  );

  console.log('[Sync] Daily sync scheduled for 3:00 AM ET');
}

/**
 * Run the full sync pipeline.
 */
export async function runSync(adapters: Map<string, PlatformAdapter>): Promise<void> {
  const stats = {
    restaurantsAdded: 0,
    restaurantsUpdated: 0,
    menusFetched: 0,
    errors: 0,
  };

  // Phase 1: Sync restaurants for user's delivery area
  // For personal MVP, use a single address from env
  const address = process.env.DELIVERY_ADDRESS || '10001'; // Default to midtown zip

  for (const [platform, adapter] of adapters) {
    console.log(`[Sync] Fetching restaurants from ${platform}...`);

    try {
      const restaurants = await adapter.searchRestaurants({
        address,
        lat: 40.7484, // Midtown default
        lng: -73.9967,
      });

      for (const rest of restaurants) {
        await upsertRestaurant(rest, platform);
        stats.restaurantsAdded++;
        await randomDelay();
      }
    } catch (err) {
      console.error(`[Sync] Error fetching restaurants from ${platform}:`, err);
      stats.errors++;
    }
  }

  // Phase 2: Fetch menus for all restaurants
  const restaurants = await db.query(
    `SELECT id, doordash_id, seamless_id FROM restaurants
     WHERE last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '24 hours'
     LIMIT 500`
  );

  for (const rest of restaurants.rows) {
    for (const [platform, adapter] of adapters) {
      const platformId = rest[`${platform}_id`];
      if (!platformId) continue;

      try {
        const menu = await adapter.getMenu(platformId);
        await upsertMenu(rest.id, platform, menu);
        stats.menusFetched++;
      } catch (err) {
        console.error(`[Sync] Error fetching menu for ${rest.id} on ${platform}:`, err);
        stats.errors++;
      }

      await randomDelay();
    }
  }

  // Phase 3: Deduplication
  console.log('[Sync] Running deduplication...');
  await deduplicateRestaurants();

  // Phase 4: Menu item matching for all matched restaurants
  const matchedRestaurants = await db.query(
    `SELECT id FROM restaurants WHERE doordash_id IS NOT NULL AND seamless_id IS NOT NULL`
  );

  for (const rest of matchedRestaurants.rows) {
    await matchMenuItems(rest.id);
  }

  // Update sync timestamps
  await db.query(
    `UPDATE restaurants SET last_synced_at = NOW()
     WHERE id IN (SELECT DISTINCT restaurant_id FROM menus WHERE fetched_at > NOW() - INTERVAL '1 hour')`
  );

  console.log('[Sync] Complete:', stats);
}

async function upsertRestaurant(
  rest: { platformId: string; name: string; address: string; lat: number; lng: number; phone?: string; cuisines: string[]; platformUrl: string },
  platform: string
): Promise<void> {
  const platformIdCol = `${platform}_id`;
  const platformUrlCol = `${platform}_url`;

  // Check if restaurant already exists on this platform
  const existing = await db.query(
    `SELECT id FROM restaurants WHERE ${platformIdCol} = $1`,
    [rest.platformId]
  );

  if (existing.rows.length > 0) {
    await db.query(
      `UPDATE restaurants SET
         canonical_name = $1, address = $2, lat = $3, lng = $4,
         phone = COALESCE($5, phone), cuisine_tags = $6, ${platformUrlCol} = $7
       WHERE ${platformIdCol} = $8`,
      [
        cleanRestaurantName(rest.name),
        rest.address,
        rest.lat,
        rest.lng,
        rest.phone,
        rest.cuisines,
        rest.platformUrl,
        rest.platformId,
      ]
    );
  } else {
    await db.query(
      `INSERT INTO restaurants (canonical_name, address, lat, lng, phone, cuisine_tags, ${platformIdCol}, ${platformUrlCol})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        cleanRestaurantName(rest.name),
        rest.address,
        rest.lat,
        rest.lng,
        rest.phone,
        rest.cuisines,
        rest.platformId,
        rest.platformUrl,
      ]
    );
  }
}

async function upsertMenu(
  restaurantId: string,
  platform: string,
  menu: { categories: Array<{ name: string; items: Array<{ platformItemId: string; name: string; description?: string; priceCents: number; imageUrl?: string; modifiers?: unknown }> }> }
): Promise<void> {
  // Upsert menu record
  const menuResult = await db.query(
    `INSERT INTO menus (restaurant_id, platform, raw_data, fetched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (restaurant_id, platform)
     DO UPDATE SET raw_data = $3, fetched_at = NOW()
     RETURNING id`,
    [restaurantId, platform, JSON.stringify(menu)]
  );

  const menuId = menuResult.rows[0].id;

  // Clear old items and insert fresh
  await db.query('DELETE FROM menu_items WHERE menu_id = $1', [menuId]);

  for (const category of menu.categories) {
    for (const item of category.items) {
      await db.query(
        `INSERT INTO menu_items
         (menu_id, restaurant_id, platform, canonical_name, original_name, description, price_cents, category, platform_item_id, modifiers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          menuId,
          restaurantId,
          platform,
          cleanRestaurantName(item.name), // reuse name cleaner for items
          item.name,
          item.description || null,
          item.priceCents,
          category.name,
          item.platformItemId,
          item.modifiers ? JSON.stringify(item.modifiers) : null,
        ]
      );
    }
  }
}
