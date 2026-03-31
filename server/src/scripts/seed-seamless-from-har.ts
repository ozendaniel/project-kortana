/**
 * Seed the database with Seamless menu data from captured HAR responses.
 * Matches against existing restaurant (seeded from DoorDash) to enable cross-platform comparison.
 * Usage: npx tsx src/scripts/seed-seamless-from-har.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const HAR_PATH = process.argv[2] || 'C:/Users/ozend/Downloads/www.seamless.com.har';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Category ID to name mapping from the enhanced_feed
const CATEGORY_NAMES: Record<string, string> = {};

async function seed() {
  console.log('[Seed Seamless] Starting...\n');
  console.log('[Seed Seamless] Reading HAR file:', HAR_PATH);

  const har = JSON.parse(fs.readFileSync(HAR_PATH, 'utf-8'));
  const entries = har.log.entries;

  // 1. Extract restaurant info from nonvolatile endpoint
  const nvEntry = entries.find((e: any) =>
    e.request.url.includes('nonvolatile') && e.response.content.text
  );
  if (!nvEntry) {
    console.error('[Seed Seamless] No nonvolatile endpoint found in HAR');
    process.exit(1);
  }

  const nvResp = JSON.parse(nvEntry.response.content.text);
  const entity = nvResp.object?.data?.content?.[0]?.entity;
  if (!entity) {
    console.error('[Seed Seamless] No restaurant entity in nonvolatile response');
    process.exit(1);
  }

  const restaurantName = entity.name;
  const seamlessId = entity.id;
  const address = entity.address;
  console.log(`[Seed Seamless] Restaurant: ${restaurantName} (seamless ID: ${seamlessId})`);

  // 2. Build category name mapping from volatile/enhanced_feed
  const volEntry = entries.find((e: any) =>
    e.request.url.includes('info/volatile') &&
    !e.request.url.includes('nonvolatile') &&
    e.response.content.text
  );
  if (volEntry) {
    const volResp = JSON.parse(volEntry.response.content.text);
    const feed = volResp.object?.data?.enhanced_feed || [];
    for (const f of feed) {
      if (f.id && f.name) {
        CATEGORY_NAMES[f.id] = f.name;
      }
    }
  }

  // 3. Extract menu items from feed endpoints
  const feedEntries = entries.filter((e: any) =>
    e.request.url.includes('restaurant_gateway/feed/' + seamlessId) &&
    e.response.content.text
  );

  const uniqueItems = new Map<string, any>();
  for (const f of feedEntries) {
    const url = new URL(f.request.url);
    const pathParts = url.pathname.split('/');
    const categoryId = pathParts[pathParts.length - 1];
    const params = Object.fromEntries(url.searchParams.entries());
    const task = params.task || '';

    const resp = JSON.parse(f.response.content.text);
    const content = resp.object?.data?.content || [];

    for (const c of content) {
      const item = c.entity;
      if (!item?.item_id) continue;

      if (!uniqueItems.has(item.item_id)) {
        // Determine category name
        let categoryName = CATEGORY_NAMES[categoryId] || 'Other';
        if (task === 'POPULAR_ITEMS') categoryName = 'Popular Items';

        uniqueItems.set(item.item_id, {
          ...item,
          _categoryName: categoryName,
          _categoryId: categoryId,
        });
      }
    }
  }

  console.log(`[Seed Seamless] Found ${uniqueItems.size} unique menu items from ${feedEntries.length} feed calls`);

  // 4. Extract fee info from restaurant availability
  const restEntry = entries.find((e: any) => {
    const url = e.request.url;
    return url.match(/restaurants\/\d+[^\/]/) && e.response.content.text && !url.includes('menu_items');
  });

  let deliveryFeeCents = 0;
  let serviceFeeCents = 0;
  if (restEntry) {
    const restResp = JSON.parse(restEntry.response.content.text);
    const avail = restResp.restaurant_availability;
    if (avail) {
      deliveryFeeCents = avail.delivery_fee?.amount || 0;
      serviceFeeCents = avail.service_fee?.amount || 0;
      console.log(`[Seed Seamless] Delivery fee: ${deliveryFeeCents}¢, Service fee: ${serviceFeeCents}¢`);
    }
  }

  // 5. Find existing restaurant by name match or insert new
  const existingRest = await pool.query(
    `SELECT id FROM restaurants WHERE canonical_name ILIKE $1 OR doordash_id IS NOT NULL`,
    [`%${restaurantName.split(' ')[0]}%`]
  );

  let restaurantId: string;
  if (existingRest.rows.length > 0) {
    restaurantId = existingRest.rows[0].id;
    // Update with Seamless IDs
    await pool.query(
      `UPDATE restaurants SET seamless_id = $1, seamless_url = $2 WHERE id = $3`,
      [seamlessId, `https://www.seamless.com/menu/${entity.merchant_url_path}`, restaurantId]
    );
    console.log(`[Seed Seamless] Linked to existing restaurant: ${restaurantId}`);
  } else {
    const lat = parseFloat(address.latitude);
    const lng = parseFloat(address.longitude);
    const cuisines = entity.menu_info?.cuisines || [];

    const result = await pool.query(
      `INSERT INTO restaurants (canonical_name, address, lat, lng, cuisine_tags, seamless_id, seamless_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        restaurantName,
        `${address.street_address}, ${address.locality}, ${address.region} ${address.postal_code}`,
        lat, lng, cuisines, seamlessId,
        `https://www.seamless.com/menu/${entity.merchant_url_path}`,
      ]
    );
    restaurantId = result.rows[0].id;
    console.log(`[Seed Seamless] Inserted new restaurant: ${restaurantId}`);
  }

  // 6. Insert Seamless menu
  const rawData = {
    restaurantId: seamlessId,
    restaurantName,
    categories: [...new Set([...uniqueItems.values()].map(i => i._categoryName))],
    itemCount: uniqueItems.size,
    deliveryFeeCents,
    serviceFeeCents,
  };

  const menuResult = await pool.query(
    `INSERT INTO menus (restaurant_id, platform, raw_data, fetched_at)
     VALUES ($1, 'seamless', $2, NOW())
     ON CONFLICT (restaurant_id, platform)
     DO UPDATE SET raw_data = $2, fetched_at = NOW()
     RETURNING id`,
    [restaurantId, JSON.stringify(rawData)]
  );
  const menuId = menuResult.rows[0].id;
  console.log(`[Seed Seamless] Upserted menu: ${menuId}`);

  // 7. Clear old Seamless items and insert fresh
  await pool.query(`DELETE FROM menu_items WHERE menu_id = $1`, [menuId]);

  let itemCount = 0;
  for (const [, item] of uniqueItems) {
    const priceCents = item.item_price?.delivery?.value || item.item_price?.pickup?.value || 0;

    await pool.query(
      `INSERT INTO menu_items
       (menu_id, restaurant_id, platform, canonical_name, original_name, description, price_cents, category, platform_item_id, available)
       VALUES ($1, $2, 'seamless', $3, $4, $5, $6, $7, $8, true)`,
      [
        menuId,
        restaurantId,
        (item.item_name || '').toLowerCase().replace(/[^\w\s]/g, '').trim(),
        item.item_name,
        item.item_description || null,
        priceCents,
        item._categoryName,
        item.item_id,
      ]
    );
    itemCount++;
  }

  console.log(`[Seed Seamless] Inserted ${itemCount} menu items`);

  // 8. Save cart/bill data for fee reference
  const billEntry = entries.find((e: any) =>
    e.request.url.includes('/bill') && e.response.content.text
  );
  if (billEntry) {
    const billResp = JSON.parse(billEntry.response.content.text);
    const feesFile = path.resolve(__dirname, '..', 'adapters', 'seamless', 'endpoints', 'fee_reference.json');
    const feeData = {
      capturedAt: new Date().toISOString(),
      restaurantId: seamlessId,
      deliveryFeeCents: billResp.charges?.fees?.delivery || 0,
      serviceFeeCents: billResp.charges?.fees?.service || 0,
      totalFeeCents: billResp.charges?.fees?.total || 0,
      feeItems: billResp.charges?.fees?.fee_items || [],
      subtotalCents: billResp.charges?.diner_subtotal || 0,
    };
    fs.writeFileSync(feesFile, JSON.stringify(feeData, null, 2), 'utf-8');
    console.log(`[Seed Seamless] Saved fee reference to ${feesFile}`);
  }

  console.log('\n[Seed Seamless] Done!');
  console.log(`[Seed Seamless] Restaurant ID: ${restaurantId}`);
  console.log(`[Seed Seamless] Menu ID: ${menuId}`);
  console.log(`[Seed Seamless] Items seeded: ${itemCount}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('[Seed Seamless] Error:', err);
  process.exit(1);
});
