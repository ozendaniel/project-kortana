/**
 * DoorDash Live Session Test
 *
 * Tests the DoorDash adapter against the real API.
 * Usage: cd server && npx tsx src/scripts/test-doordash-live.ts
 *
 * Steps:
 * 1. Launches real Chrome via CDP (same pattern as working Seamless adapter)
 * 2. Checks for existing session, prompts manual OTP login if needed
 * 3. Tests searchRestaurants, getMenu, getFees sequentially
 * 4. Reports results and any issues
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { DoorDashAdapter } from '../adapters/doordash/adapter.js';

// ── Config ──────────────────────────────────────────────────────────
// NYC test address (Midtown Manhattan)
const TEST_ADDRESS = '350 5th Ave, New York, NY 10118';
const TEST_LAT = 40.7484;
const TEST_LNG = -73.9857;

// ── Helpers ─────────────────────────────────────────────────────────
function hr(label: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(60)}\n`);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const email = process.env.DOORDASH_EMAIL;
  if (!email) {
    console.error('ERROR: Set DOORDASH_EMAIL in .env first');
    process.exit(1);
  }

  hr('DOORDASH LIVE SESSION TEST');
  console.log(`Email: ${email}`);
  console.log(`Test address: ${TEST_ADDRESS}`);
  console.log(`Coordinates: ${TEST_LAT}, ${TEST_LNG}`);

  const adapter = new DoorDashAdapter();

  // ── Step 1: Initialize (browser launch + login check) ──────────
  hr('STEP 1: Initialize & Login');
  console.log('Launching Chrome via CDP (port 9224)...');
  console.log('If not logged in, a Chrome window will open — log in manually with OTP.');
  console.log('You have 3 minutes to complete login.\n');

  try {
    await adapter.initialize({ email });
  } catch (err) {
    console.error('FAILED to initialize adapter:', err);
    console.log('\n--- TROUBLESHOOTING ---');
    console.log('1. Is Chrome already running? Close all Chrome windows first.');
    console.log('2. Is port 9224 in use? Run: netstat -ano | findstr 9224');
    console.log('3. Is Chrome installed at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe?');
    process.exit(1);
  }

  // Verify session is valid
  const valid = await adapter.isSessionValid();
  if (!valid) {
    console.error('Session is NOT valid after initialization. Login may have failed or timed out.');
    console.log('Try running this script again and completing the OTP login within 3 minutes.');
    process.exit(1);
  }
  console.log('✓ Session is valid and authenticated.');
  console.log('Waiting 10s for DoorDash SPA to finish its own API calls...\n');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // ── Step 2: Search Restaurants ─────────────────────────────────
  hr('STEP 2: Search Restaurants');
  console.log(`Searching near: ${TEST_ADDRESS}\n`);

  let restaurants: Awaited<ReturnType<typeof adapter.searchRestaurants>> = [];
  try {
    restaurants = await adapter.searchRestaurants({
      address: TEST_ADDRESS,
      lat: TEST_LAT,
      lng: TEST_LNG,
    });

    if (restaurants.length === 0) {
      console.log('WARNING: Search returned 0 restaurants.');
      console.log('This could mean:');
      console.log('  - Cloudflare blocked the GraphQL request');
      console.log('  - The delivery address was not set correctly');
      console.log('  - DoorDash returned an unexpected response format');
      console.log('\nTry running the search with a restaurant name filter...');

      restaurants = await adapter.searchRestaurants({
        address: TEST_ADDRESS,
        lat: TEST_LAT,
        lng: TEST_LNG,
        query: 'pizza',
      });
    }

    console.log(`Found ${restaurants.length} restaurants.\n`);
    // Show first 5
    const preview = restaurants.slice(0, 5);
    for (const r of preview) {
      console.log(`  [${r.platformId}] ${r.name}`);
      console.log(`    Address: ${r.address}`);
      console.log(`    Cuisines: ${r.cuisines.join(', ') || 'none'}`);
      console.log(`    Rating: ${r.rating ?? 'n/a'} | Delivery: ${r.deliveryTime ?? 'n/a'} | Fee: ${r.deliveryFee != null ? formatCents(r.deliveryFee) : 'n/a'}`);
      console.log('');
    }
    if (restaurants.length > 5) {
      console.log(`  ... and ${restaurants.length - 5} more.\n`);
    }
  } catch (err) {
    console.error('FAILED searchRestaurants:', err);
    console.log('Continuing to test other methods...\n');
  }

  // ── Step 3: Get Menu ───────────────────────────────────────────
  if (restaurants.length > 0) {
    const testRestaurant = restaurants[0];
    hr('STEP 3: Get Menu');
    console.log(`Fetching menu for: ${testRestaurant.name} (ID: ${testRestaurant.platformId})\n`);

    try {
      const menu = await adapter.getMenu(testRestaurant.platformId);

      if (menu.categories.length === 0) {
        console.log('WARNING: Menu returned 0 categories.');
        console.log('The storepageFeed query may need different variables or the response format changed.');
      } else {
        let totalItems = 0;
        for (const cat of menu.categories) {
          totalItems += cat.items.length;
          console.log(`  ${cat.name} (${cat.items.length} items)`);
          // Show first 3 items per category
          for (const item of cat.items.slice(0, 3)) {
            console.log(`    - ${item.name}: ${formatCents(item.priceCents)}${item.platformItemId ? ` [${item.platformItemId}]` : ''}`);
          }
          if (cat.items.length > 3) {
            console.log(`    ... +${cat.items.length - 3} more`);
          }
        }
        console.log(`\n✓ Menu loaded: ${menu.categories.length} categories, ${totalItems} items total.\n`);

        // ── Step 4: Get Fees ─────────────────────────────────────
        // Pick a simple item (sides, drinks) less likely to have required modifiers
        const simpleCategories = ['Side Orders', 'Sides', 'French Fries', 'Cold Beverages', 'Beverages', 'Drinks', 'Desserts'];
        let testItem = null;
        for (const targetCat of simpleCategories) {
          const cat = menu.categories.find(c => c.name.toLowerCase().includes(targetCat.toLowerCase()));
          if (cat?.items[0]) { testItem = cat.items[0]; break; }
        }
        // Fallback: just pick the first item
        if (!testItem) testItem = menu.categories[0]?.items[0];

        if (testItem?.platformItemId) {
          const firstItem = testItem;
          hr('STEP 4: Get Fees (Cart Test)');
          console.log(`Adding to cart: ${firstItem.name} (${formatCents(firstItem.priceCents)}) x1\n`);

          try {
            const fees = await adapter.getFees({
              platformRestaurantId: testRestaurant.platformId,
              items: [{ platformItemId: firstItem.platformItemId, quantity: 1 }],
              deliveryAddress: { lat: TEST_LAT, lng: TEST_LNG, address: TEST_ADDRESS },
            });

            console.log('  Fee Breakdown:');
            console.log(`    Subtotal:         ${formatCents(fees.subtotalCents)}`);
            console.log(`    Delivery fee:     ${formatCents(fees.deliveryFeeCents)}`);
            console.log(`    Service fee:      ${formatCents(fees.serviceFeeCents)}`);
            console.log(`    Small order fee:  ${formatCents(fees.smallOrderFeeCents)}`);
            console.log(`    ─────────────────────`);
            console.log(`    TOTAL:            ${formatCents(fees.totalCents)}`);
            if (fees.estimatedDeliveryTime) {
              console.log(`    Delivery time:    ${fees.estimatedDeliveryTime}`);
            }

            if (fees.totalCents === 0) {
              console.log('\nWARNING: Total is $0.00 — fee extraction may not be working.');
              console.log('The addCartItem response may have a different structure than expected.');
              console.log('Check the cart response for the actual fee fields.');
            } else {
              console.log('\n✓ Fees calculated successfully.');
            }
          } catch (err) {
            console.error('FAILED getFees:', err);
          }
        } else {
          console.log('\nSkipping fee test — no item with a valid platformItemId found.');
        }
      }
    } catch (err) {
      console.error('FAILED getMenu:', err);
    }
  } else {
    console.log('Skipping menu and fee tests — no restaurants found from search.');
  }

  // ── Summary ────────────────────────────────────────────────────
  hr('TEST COMPLETE');
  console.log('Results:');
  console.log(`  Restaurants found: ${restaurants.length}`);
  console.log('');
  console.log('If any step failed, check the error output above.');
  console.log('Common issues:');
  console.log('  - Cloudflare challenge: try closing Chrome, clearing ~/.kortana/doordash-profile, and re-running');
  console.log('  - Empty search results: GraphQL response format may have changed — inspect network tab');
  console.log('  - Fee extraction zeros: cart response structure may differ from captured sample');
  console.log('');
  console.log('Press Ctrl+C to exit (Chrome window will remain open for inspection).');

  // Keep process alive so user can inspect the browser
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
