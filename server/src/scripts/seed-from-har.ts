/**
 * Seed the database with restaurant and menu data from captured DoorDash responses.
 * Usage: npx tsx src/scripts/seed-from-har.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const QUERIES_DIR = path.resolve(__dirname, '..', 'adapters', 'doordash', 'queries');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function parsePriceToCents(displayPrice: string): number {
  // "$19.80" -> 1980
  const cleaned = displayPrice.replace(/[^0-9.]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
}

async function seed() {
  console.log('[Seed] Starting...\n');

  // Load storepageFeed response
  const storeResponse = JSON.parse(
    fs.readFileSync(path.join(QUERIES_DIR, 'storepageFeed.response.json'), 'utf-8')
  );

  const store = storeResponse.data.storepageFeed;
  const header = store.storeHeader;

  // 1. Insert restaurant
  const cuisines = (header.businessTags || []).map((t: { name: string }) => t.name);

  const restResult = await pool.query(
    `INSERT INTO restaurants (canonical_name, address, lat, lng, cuisine_tags, doordash_id, doordash_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      header.name,
      header.address.displayAddress,
      parseFloat(header.address.lat),
      parseFloat(header.address.lng),
      cuisines,
      header.id,
      `https://www.doordash.com/store/${header.id}`,
    ]
  );

  let restaurantId: string;
  if (restResult.rows.length > 0) {
    restaurantId = restResult.rows[0].id;
    console.log(`[Seed] Inserted restaurant: ${header.name} (${restaurantId})`);
  } else {
    const existing = await pool.query('SELECT id FROM restaurants WHERE doordash_id = $1', [header.id]);
    restaurantId = existing.rows[0].id;
    console.log(`[Seed] Restaurant already exists: ${header.name} (${restaurantId})`);
  }

  // 2. Insert menu
  const menuResult = await pool.query(
    `INSERT INTO menus (restaurant_id, platform, raw_data, fetched_at)
     VALUES ($1, 'doordash', $2, NOW())
     ON CONFLICT (restaurant_id, platform)
     DO UPDATE SET raw_data = $2, fetched_at = NOW()
     RETURNING id`,
    [restaurantId, JSON.stringify(store)]
  );
  const menuId = menuResult.rows[0].id;
  console.log(`[Seed] Upserted menu: ${menuId}`);

  // 3. Clear old items and insert fresh
  await pool.query('DELETE FROM menu_items WHERE menu_id = $1', [menuId]);

  let itemCount = 0;
  for (const category of store.itemLists) {
    for (const item of category.items) {
      const priceCents = parsePriceToCents(item.displayPrice || '$0.00');

      await pool.query(
        `INSERT INTO menu_items
         (menu_id, restaurant_id, platform, canonical_name, original_name, description, price_cents, category, platform_item_id, available)
         VALUES ($1, $2, 'doordash', $3, $4, $5, $6, $7, $8, true)`,
        [
          menuId,
          restaurantId,
          (item.name || '').toLowerCase().replace(/[^\w\s]/g, '').trim(),
          item.name,
          item.description || null,
          priceCents,
          category.name,
          item.id,
        ]
      );
      itemCount++;
    }
  }

  console.log(`[Seed] Inserted ${itemCount} menu items across ${store.itemLists.length} categories`);

  // Also seed from homePageFacetFeed if we have restaurant list data
  // (This is harder to parse since it's a complex facet structure — skip for now)

  console.log('\n[Seed] Done! You can now browse this restaurant in the app.');
  console.log(`[Seed] Restaurant ID: ${restaurantId}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});
