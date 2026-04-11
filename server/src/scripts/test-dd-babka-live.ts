/**
 * End-to-end test for DoorDash live fee fetch with modifier support.
 *
 * Target: HH Bagels → Babka Loaf (has a required flavor modifier).
 *
 * Steps:
 *   1. Run backfill-dd-modifiers for HH Bagels (fetches modifier_groups + menu_platform_id)
 *   2. Load the Babka Loaf item from the DB with its modifier data
 *   3. Call DoorDashAdapter.getFees() with the enriched item
 *   4. Log the real bill from DoorDash's detailedCartItems response
 *
 * Expected: A real, itemized fee breakdown that matches what the DoorDash
 * website would show you for the same cart. For DashPass users, delivery
 * should be $0.
 *
 * Usage:
 *   npx tsx src/scripts/test-dd-babka-live.ts                # Full flow
 *   npx tsx src/scripts/test-dd-babka-live.ts --skip-backfill # Assume modifiers are already cached
 */
import dotenv from 'dotenv';
import path from 'path';
import { spawn } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { findChromePath, getProfileDir, getChromeArgs, cleanProfileLocks } from '../utils/chrome.js';

const args = process.argv.slice(2);
const skipBackfill = args.includes('--skip-backfill');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== DoorDash Babka Loaf live fee test ===\n');

  // Pre-spawn Chrome headful on CDP 9224
  const CDP_PORT = 9224;
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (resp.ok) {
      const { execSync } = await import('child_process');
      const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${CDP_PORT}"`, { encoding: 'utf-8' });
      const pidMatch = out.trim().match(/\s(\d+)\s*$/m);
      if (pidMatch) {
        execSync(`taskkill /PID ${pidMatch[1]} /T /F`, { stdio: 'ignore' });
        await sleep(2000);
      }
    }
  } catch {}

  const chromePath = findChromePath();
  const profileDir = getProfileDir('doordash');
  cleanProfileLocks(profileDir);
  const chromeArgs = getChromeArgs({ cdpPort: CDP_PORT, profileDir, headless: false });
  console.log('Launching Chrome headful for DoorDash...');
  const chromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
  await sleep(3000);

  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
    console.log('Chrome CDP alive.');
  } catch {
    console.error(`Chrome failed on port ${CDP_PORT}`);
    process.exit(1);
  }

  const adapter = new DoorDashAdapter();
  if (!process.env.DOORDASH_EMAIL) {
    console.error('DOORDASH_EMAIL not set');
    process.exit(1);
  }
  console.log('Initializing DoorDash adapter...');
  await adapter.initialize({ email: process.env.DOORDASH_EMAIL });
  if (adapter.getStatus() !== 'authenticated') {
    console.error('DoorDash not authenticated. Log in via Settings portal first.');
    process.exit(1);
  }

  // Load DD homepage for SPA context
  const mainPage = adapter.getBrowser().getPage();
  if (mainPage) {
    console.log('Loading DoorDash homepage for SPA context...');
    await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(5000);
  }
  console.log('DoorDash ready.\n');

  // Find the HH Bagels restaurant
  const restRes = await db.query(`
    SELECT id, canonical_name, doordash_id
    FROM restaurants
    WHERE canonical_name = 'hh bagels' AND doordash_id IS NOT NULL
    ORDER BY (SELECT COUNT(*) FROM menu_items mi WHERE mi.restaurant_id = restaurants.id) DESC
    LIMIT 1
  `);
  if (restRes.rows.length === 0) {
    console.error('HH Bagels not found in DB');
    process.exit(1);
  }
  const rest = restRes.rows[0];
  console.log(`Target restaurant: ${rest.canonical_name} (DD:${rest.doordash_id})`);

  // Find the Babka Loaf item
  const itemRes = await db.query(`
    SELECT id, original_name, description, price_cents, platform_item_id,
           menu_platform_id, modifier_groups
    FROM menu_items
    WHERE restaurant_id = $1 AND platform = 'doordash'
      AND LOWER(original_name) = 'babka loaf'
    LIMIT 1
  `, [rest.id]);
  if (itemRes.rows.length === 0) {
    console.error('Babka Loaf not found');
    process.exit(1);
  }
  const item = itemRes.rows[0];
  console.log(`Target item: ${item.original_name} $${(item.price_cents/100).toFixed(2)} (DD:${item.platform_item_id})`);
  console.log(`  menu_platform_id: ${item.menu_platform_id || '(missing)'}`);
  console.log(`  modifier_groups:  ${item.modifier_groups ? 'cached' : '(missing)'}`);

  // Backfill if missing
  if (!skipBackfill && (!item.menu_platform_id || !item.modifier_groups)) {
    console.log('\n→ Running backfill for HH Bagels...');
    // Fetch storepageFeed to get menuId + identify needy items
    const storeQuery = (await import('fs')).readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..', 'adapters', 'doordash', 'queries', 'storepageFeed.graphql'),
      'utf-8'
    );
    const queryLines = storeQuery.split('\n');
    const start = queryLines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
    const cleanQuery = queryLines.slice(start).join('\n');

    const browser = adapter.getBrowser();
    const feedResult = await browser.mainTabGraphqlQuery<any>('storepageFeed', cleanQuery, {
      storeId: rest.doordash_id,
      menuId: null,
      isMerchantPreview: false,
      fulfillmentType: 'Delivery',
      cursor: null,
      scheduledTime: null,
      entryPoint: 'HomePage',
    }, 1);

    const menuPlatformId = feedResult?.data?.storepageFeed?.menuBook?.id;
    console.log(`  storepageFeed menuBook.id = ${menuPlatformId}`);

    if (menuPlatformId) {
      await db.query(
        `UPDATE menu_items SET menu_platform_id = $1
         WHERE restaurant_id = $2 AND platform = 'doordash' AND menu_platform_id IS NULL`,
        [menuPlatformId, rest.id]
      );
    }

    // Fetch modifiers for the babka
    console.log(`  Fetching modifiers for babka loaf...`);
    const groups = await adapter.fetchItemModifiers(rest.doordash_id, item.platform_item_id, menuPlatformId || undefined);
    console.log(`  Got ${groups.length} modifier groups:`);
    for (const g of groups) {
      console.log(`    "${g.name}" (${g.selectionMode}, min=${g.minSelection}, max=${g.maxSelection}, ${g.options.length} options)`);
      for (const opt of g.options) {
        console.log(`      - ${opt.name} (+$${(opt.priceDeltaCents/100).toFixed(2)})${opt.isDefault ? ' [default]' : ''}`);
      }
    }

    if (groups.length > 0) {
      await db.query(
        `UPDATE menu_items SET modifier_groups = $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(groups), item.id]
      );
      console.log('  ✓ Cached modifier_groups');
    }

    // Re-load the item with cached data
    const reloaded = await db.query(`
      SELECT id, original_name, description, price_cents, platform_item_id,
             menu_platform_id, modifier_groups
      FROM menu_items WHERE id = $1
    `, [item.id]);
    Object.assign(item, reloaded.rows[0]);
  }

  console.log('\n--- Item ready for getFees ---');
  console.log(`  name: ${item.original_name}`);
  console.log(`  description: ${item.description?.substring(0, 80) || '(none)'}`);
  console.log(`  unitPrice: ${item.price_cents}`);
  console.log(`  menuId: ${item.menu_platform_id}`);
  console.log(`  modifier groups: ${item.modifier_groups ? (item.modifier_groups as any[]).length : 0}`);

  // Call getFees
  console.log('\n→ Calling adapter.getFees()...');
  const startTime = Date.now();
  try {
    const fees = await adapter.getFees({
      platformRestaurantId: rest.doordash_id,
      items: [{
        platformItemId: item.platform_item_id,
        quantity: 1,
        name: item.original_name,
        description: item.description || undefined,
        unitPriceCents: item.price_cents,
        menuPlatformId: item.menu_platform_id || undefined,
        modifierGroups: item.modifier_groups || undefined,
        modifierSelections: [],  // auto-populate defaults
      }],
      deliveryAddress: { lat: 40.7449, lng: -73.9845, address: '15 East 30th Street, New York, NY 10016' },
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✓ getFees succeeded in ${elapsed}s\n`);
    console.log('--- Live DoorDash fees for Babka Loaf ---');
    console.log(`  Subtotal:     $${(fees.subtotalCents/100).toFixed(2)}`);
    console.log(`  Delivery:     $${(fees.deliveryFeeCents/100).toFixed(2)}`);
    console.log(`  Service:      $${(fees.serviceFeeCents/100).toFixed(2)}`);
    console.log(`  Small order:  $${(fees.smallOrderFeeCents/100).toFixed(2)}`);
    console.log(`  Tax:          $${(fees.taxCents/100).toFixed(2)}`);
    console.log(`  Discount:     $${(fees.discountCents/100).toFixed(2)}`);
    console.log(`  Total:        $${(fees.totalCents/100).toFixed(2)}`);
    if (fees.estimatedDeliveryTime) console.log(`  ETA:          ${fees.estimatedDeliveryTime}`);
    console.log();
    console.log('--- User-reported live values ---');
    console.log('  With DashPass:    $18.65 + $0.00 + $5.64 = $24.29');
    console.log('  Without DashPass: $18.65 + $3.99 + $6.65 = $29.29');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ getFees failed: ${msg}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    }
    process.exit(1);
  }

  try { chromeProc.kill(); } catch {}
  process.exit(0);
}

main().catch(err => {
  console.error('[Test] Fatal error:', err);
  process.exit(1);
});
