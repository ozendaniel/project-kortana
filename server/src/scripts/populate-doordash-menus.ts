/**
 * Bulk-fetch DoorDash menus and populate the DB.
 *
 * Usage:
 *   npx tsx src/scripts/populate-doordash-menus.ts                    # All DoorDash restaurants
 *   npx tsx src/scripts/populate-doordash-menus.ts --matched-only     # Only cross-platform matched
 *   npx tsx src/scripts/populate-doordash-menus.ts --limit 10         # First 10 restaurants
 *   npx tsx src/scripts/populate-doordash-menus.ts --resume           # Skip recently synced (24h)
 *   npx tsx src/scripts/populate-doordash-menus.ts --restaurant-id X  # Single restaurant
 *   npx tsx src/scripts/populate-doordash-menus.ts --dry-run          # Fetch but don't write to DB
 *   npx tsx src/scripts/populate-doordash-menus.ts --skip-match       # Don't run item matching after
 *   npx tsx src/scripts/populate-doordash-menus.ts --sustained        # Longer delays for multi-hour runs
 *
 * Requires an authenticated DoorDash session (login via Settings page first).
 * Uses CDP port 9224 — can run alongside Seamless scripts on port 9223.
 *
 * IMPORTANT: Pre-spawns Chrome HEADFUL before adapter init.
 * Cloudflare blocks headless Chrome with 403 on GraphQL requests.
 * The adapter's launch() tries to spawn headless Chrome on the same port,
 * fails silently, and connects to the already-running headful instance.
 *
 * For long unattended runs, use the wrapper script:
 *   bash server/scripts/run-doordash-populate.sh
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { upsertMenu } from '../services/menu-upsert.js';
import { matchMenuItems, validateMatches } from '../services/matching.js';
import { findChromePath, getProfileDir, getChromeArgs, cleanProfileLocks } from '../utils/chrome.js';
import { acquireLock } from '../utils/process-lock.js';
import type { PlatformMenu } from '../adapters/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, '..', 'adapters', 'doordash', 'queries');

// --- Helpers ---
function loadQuery(filename: string): string {
  const raw = fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
  const lines = raw.split('\n');
  const queryStart = lines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
  return lines.slice(queryStart).join('\n');
}

function parsePriceToCents(displayPrice: string): number {
  const cleaned = displayPrice.replace(/[^0-9.]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
}

// --- CLI args ---
const args = process.argv.slice(2);
const matchedOnly = args.includes('--matched-only');
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');
const skipMatch = args.includes('--skip-match');
const sustained = args.includes('--sustained');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const ridIdx = args.indexOf('--restaurant-id');
const singleRestaurantId = ridIdx !== -1 ? args[ridIdx + 1] : null;

// --- Config (more conservative than discovery — DoorDash 429s are aggressive) ---
const INTER_RESTAURANT_DELAY_MS = sustained ? 12000 : 8000;
const INTER_RESTAURANT_JITTER_MS = sustained ? 5000 : 4000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;       // 60s after a 429
const HARD_COOLDOWN_MS = 300_000;             // 5 min after 3 consecutive 429s
const MAX_CONSECUTIVE_429 = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const SESSION_CHECK_INTERVAL = 50;
const SESSION_KEEPALIVE_INTERVAL = sustained ? 100 : 150;
const BACKOFF_DELAYS = [30_000, 60_000, 120_000];
const PROGRESS_FILE = path.resolve(process.cwd(), 'data', 'doordash-menu-progress.json');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(): number {
  return INTER_RESTAURANT_DELAY_MS + Math.random() * INTER_RESTAURANT_JITTER_MS;
}

interface ProgressState {
  startedAt: string;
  completed: number;
  failed: number;
  skipped: number;
  totalItems: number;
  enrichedAddresses: number;
  lastRestaurantId: string | null;
}

interface StoreAddress {
  displayAddress: string;
  street: string;
  lat: number;
  lng: number;
  city: string;
  state: string;
}

interface FetchMenuResult {
  menu: PlatformMenu;
  address?: StoreAddress;
  phone?: string;
  fees?: import('../services/fees.js').CachedFees;
}

function saveProgress(state: ProgressState): void {
  try {
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

/**
 * Fetch menu via the MAIN tab's GraphQL context.
 *
 * Must use mainTabGraphqlQuery (not API tab's graphqlQuery) because
 * Cloudflare blocks the API tab — its route blocking prevents CF challenge JS from loading.
 * The main tab has full DoorDash JS/CF context after navigating to doordash.com.
 *
 * Unlike adapter.getMenu(), this throws on errors so the script can handle 429s properly.
 */
async function fetchMenu(adapter: DoorDashAdapter, storeId: string): Promise<FetchMenuResult> {
  const browser = adapter.getBrowser();
  const query = loadQuery('storepageFeed.graphql');

  const result = await browser.mainTabGraphqlQuery<{
    data: {
      storepageFeed: {
        storeHeader: {
          id: string;
          name: string;
          address?: {
            lat: string;
            lng: string;
            street: string;
            displayAddress: string;
            city: string;
            state: string;
          };
          deliveryFeeLayout?: {
            title?: string | null;
            displayDeliveryFee?: string | null;
          } | null;
        };
        mxInfo?: {
          phoneno?: string;
          address?: {
            lat: string;
            lng: string;
            street: string;
            displayAddress: string;
            city: string;
            state: string;
          };
        };
        itemLists: Array<{
          name: string;
          items: Array<{
            id: string;
            name: string;
            description?: string;
            displayPrice: string;
            imageUrl?: string;
          }>;
        }>;
      };
    };
  }>('storepageFeed', query, {
    storeId,
    menuId: null,
    isMerchantPreview: false,
    fulfillmentType: 'Delivery',
    cursor: null,
    scheduledTime: null,
    entryPoint: 'HomePage',
  }, 2); // maxRetries=2 (3 total attempts) — let script handle broader backoff

  const store = result.data?.storepageFeed;

  // Extract address from storeHeader (fall back to mxInfo)
  const rawAddr = store?.storeHeader?.address || store?.mxInfo?.address;
  let address: StoreAddress | undefined;
  if (rawAddr?.displayAddress) {
    address = {
      displayAddress: rawAddr.displayAddress,
      street: rawAddr.street,
      lat: parseFloat(rawAddr.lat),
      lng: parseFloat(rawAddr.lng),
      city: rawAddr.city,
      state: rawAddr.state,
    };
  }

  // Extract phone from mxInfo
  const phone = store?.mxInfo?.phoneno || undefined;

  // Extract fee structure from storepageFeed (delivery fee display string)
  let fees: import('../services/fees.js').CachedFees | undefined;
  if (store?.storeHeader) {
    const { extractDoorDashFees } = await import('../services/fees.js');
    const extracted = extractDoorDashFees(store.storeHeader);
    if (extracted) fees = extracted;
  }

  if (!store?.itemLists) {
    return { menu: { categories: [] }, address, phone, fees };
  }

  const categories = store.itemLists.map(cat => ({
    name: cat.name,
    items: cat.items.map(item => ({
      platformItemId: item.id,
      name: item.name,
      description: item.description || undefined,
      priceCents: parsePriceToCents(item.displayPrice || '$0.00'),
      imageUrl: item.imageUrl || undefined,
    })),
  }));

  return { menu: { categories }, address, phone, fees };
}

/**
 * Session health check via getAvailableAddresses query on the main tab.
 * Uses mainTabGraphqlQuery since the API tab's route blocking prevents Cloudflare challenge.
 */
async function checkSessionHealth(adapter: DoorDashAdapter): Promise<boolean> {
  const browser = adapter.getBrowser();
  try {
    const query = loadQuery('getAvailableAddresses.graphql');
    const result = await browser.mainTabGraphqlQuery<any>('getAvailableAddresses', query, {}, 1);
    const addresses = result?.data?.getAvailableAddresses;
    if (Array.isArray(addresses) && addresses.length > 0) return true;
    console.error('[Health] No addresses returned — session may be expired.');
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('403') || msg.includes('401')) {
      console.error('[Health] Session expired (auth error).');
      return false;
    }
    // Other errors (context loss, timeout) don't necessarily mean session is dead
    console.warn(`[Health] Check inconclusive: ${msg.substring(0, 80)}. Continuing.`);
    return true;
  }
}

async function main() {
  console.log('=== DoorDash Menu Bulk Population ===\n');
  if (dryRun) console.log('*** DRY RUN — no DB writes ***\n');

  // Acquire the populate lock so the dev server (and any other tools) know
  // to skip initializing the DoorDash adapter while we're running.
  // Cleanup on exit is registered automatically.
  try {
    acquireLock('doordash-populate', { script: 'populate-doordash-menus.ts' });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Build query for target restaurants
  const conditions: string[] = [
    'doordash_id IS NOT NULL',
    `(platform_status->>'doordash' IS NULL OR platform_status->>'doordash' != 'delisted')`,
  ];
  const params: unknown[] = [];

  if (singleRestaurantId) {
    params.push(singleRestaurantId);
    conditions.push(`id = $${params.length}`);
  }

  if (matchedOnly) {
    conditions.push('seamless_id IS NOT NULL');
  }

  if (resume) {
    conditions.push(`(last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '24 hours')`);
  }

  let query = `SELECT id, canonical_name, doordash_id, seamless_id, last_synced_at
    FROM restaurants
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE WHEN last_synced_at IS NULL THEN 0 ELSE 1 END,
      last_synced_at ASC NULLS FIRST`;

  if (limit > 0) {
    query += ` LIMIT ${limit}`;
  }

  const result = await db.query(query, params);
  const restaurants = result.rows;

  if (restaurants.length === 0) {
    console.log('No restaurants to process.');
    process.exit(0);
  }

  // Count totals for context
  const totalDD = await db.query('SELECT COUNT(*) as count FROM restaurants WHERE doordash_id IS NOT NULL');
  const totalMatched = await db.query('SELECT COUNT(*) as count FROM restaurants WHERE doordash_id IS NOT NULL AND seamless_id IS NOT NULL');

  console.log(`Target: ${restaurants.length} restaurants`);
  console.log(`  (Total DoorDash: ${totalDD.rows[0].count}, Matched: ${totalMatched.rows[0].count})`);
  if (matchedOnly) console.log('  Mode: matched-only');
  if (resume) console.log('  Mode: resume (skipping recently synced)');
  if (sustained) console.log('  Mode: sustained (longer delays, frequent keep-alive)');
  console.log();

  // Pre-spawn Chrome HEADFUL on CDP port 9224.
  // Cloudflare blocks headless Chrome with 403 on GraphQL requests.
  // The adapter's launch() will try to spawn headless Chrome on the same port,
  // fail silently (port taken), and connect to this headful instance instead.
  const CDP_PORT = 9224;

  // Kill any stale Chrome on this port first
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (resp.ok) {
      console.log(`Stale Chrome found on port ${CDP_PORT} — killing it...`);
      const { execSync } = await import('child_process');
      // Find PID listening on port and kill its process tree
      const netstatOutput = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${CDP_PORT}"`, { encoding: 'utf-8' });
      const pidMatch = netstatOutput.trim().match(/\s(\d+)\s*$/m);
      if (pidMatch) {
        execSync(`taskkill /PID ${pidMatch[1]} /T /F`, { stdio: 'ignore' });
        console.log(`Killed stale Chrome (PID ${pidMatch[1]})`);
        await sleep(2000);
      }
    }
  } catch { /* no stale Chrome — good */ }

  const chromePath = findChromePath();
  const profileDir = getProfileDir('doordash');
  cleanProfileLocks(profileDir);
  const chromeArgs = getChromeArgs({ cdpPort: CDP_PORT, profileDir, headless: false });
  console.log('Launching Chrome headful for DoorDash...');
  const chromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
  chromeProc.on('exit', (code) => {
    console.warn(`[Chrome] Launcher process exited with code ${code}`);
  });
  await sleep(3000);

  // Verify CDP is alive
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
    console.log(`Chrome CDP alive on port ${CDP_PORT}`);
  } catch {
    console.error(`Chrome failed to start on port ${CDP_PORT}. Is it already in use?`);
    process.exit(1);
  }

  // Initialize adapter — connects to the headful Chrome we just spawned
  console.log('Initializing DoorDash adapter...');
  const adapter = new DoorDashAdapter();
  await adapter.initialize({
    email: process.env.DOORDASH_EMAIL || '',
  });

  if (adapter.getStatus() !== 'authenticated') {
    console.error('DoorDash session not authenticated. Please login via Settings page first.');
    process.exit(1);
  }

  // Navigate main tab to DoorDash homepage to establish full SPA + Cloudflare context.
  // mainTabGraphqlQuery needs this context for fetch() calls to succeed.
  const mainPage = adapter.getBrowser().getPage();
  if (mainPage) {
    console.log('Loading DoorDash homepage for SPA context...');
    await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(5000);
  }

  console.log('DoorDash adapter ready.\n');

  // Track progress
  const progress: ProgressState = {
    startedAt: new Date().toISOString(),
    completed: 0,
    failed: 0,
    skipped: 0,
    totalItems: 0,
    enrichedAddresses: 0,
    lastRestaurantId: null,
  };

  let consecutiveFailures = 0;
  let consecutive429s = 0;
  const matchedRestaurantIds: string[] = [];
  const startTime = Date.now();

  for (let i = 0; i < restaurants.length; i++) {
    const rest = restaurants[i];
    const restStart = Date.now();

    // Session keep-alive: navigate main tab to doordash.com to refresh cookies
    if (i > 0 && i % SESSION_KEEPALIVE_INTERVAL === 0) {
      console.log(`\n[Keep-alive] Navigating to doordash.com to refresh cookies... (${i}/${restaurants.length})`);
      try {
        const browser = adapter.getBrowser();
        await browser.navigateHome();
        await sleep(3000);
        const healthy = await checkSessionHealth(adapter);
        if (healthy) {
          console.log('[Keep-alive] Session refreshed OK.');
        } else {
          console.error('\n*** Session expired during keep-alive. Exiting for restart. ***');
          saveProgress(progress);
          process.exit(1);
        }
      } catch (err) {
        console.log(`[Keep-alive] Navigation failed: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
      }
    }

    // Session health check every N restaurants
    if (i > 0 && i % SESSION_CHECK_INTERVAL === 0 && i % SESSION_KEEPALIVE_INTERVAL !== 0) {
      console.log(`\n[Health check] Verifying session... (${i}/${restaurants.length})`);
      const healthy = await checkSessionHealth(adapter);
      if (!healthy) {
        console.log('[Health check] Session may be expired. Attempting keep-alive...');
        try {
          const browser = adapter.getBrowser();
          await browser.navigateHome();
          await sleep(3000);
          const recovered = await checkSessionHealth(adapter);
          if (!recovered) {
            console.error('\n*** Auth expired and could not be refreshed. Exiting for restart. ***');
            console.log(`Progress: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped`);
            saveProgress(progress);
            process.exit(1);
          }
          console.log('[Health check] Session recovered via keep-alive.');
        } catch {
          console.error('\n*** Auth check failed. Exiting for restart. ***');
          saveProgress(progress);
          process.exit(1);
        }
      } else {
        console.log('[Health check] Session OK.');
      }
    }

    try {
      console.log(`[${i + 1}/${restaurants.length}] ${rest.canonical_name} (DD:${rest.doordash_id})...`);

      const { menu, address, phone, fees } = await fetchMenu(adapter, rest.doordash_id);
      const itemCount = menu.categories.reduce((a, c) => a + c.items.length, 0);

      // Enrich address if we got one and the restaurant has placeholder/missing data
      if (address && !dryRun) {
        const enrichResult = await db.query(
          `UPDATE restaurants SET address = $1, lat = $2, lng = $3, phone = COALESCE($4, phone)
           WHERE id = $5 AND (address IS NULL OR address = '' OR (lat = 40.748 AND lng = -73.997))`,
          [address.displayAddress, address.lat, address.lng, phone || null, rest.id]
        );
        if (enrichResult.rowCount && enrichResult.rowCount > 0) {
          console.log(`  📍 ${address.displayAddress}`);
          progress.enrichedAddresses++;
        }
      } else if (address && dryRun) {
        console.log(`  📍 [DRY RUN] ${address.displayAddress}`);
      }

      // Cache per-restaurant fee structure for comparison engine
      if (fees && !dryRun) {
        await db.query(
          `UPDATE restaurants
             SET platform_fees = jsonb_set(COALESCE(platform_fees, '{}'), '{doordash}', $1::jsonb)
             WHERE id = $2`,
          [JSON.stringify(fees), rest.id]
        );
        console.log(`  💰 fees: delivery $${(fees.deliveryFeeCents/100).toFixed(2)}, service ${(fees.serviceFeeRate*100).toFixed(0)}%`);
      }

      if (itemCount === 0) {
        // Mark as delisted — restaurant exists in search but has no active menu
        if (!dryRun) {
          await db.query(
            `UPDATE restaurants SET platform_status = jsonb_set(COALESCE(platform_status, '{}'), '{doordash}', '"delisted"') WHERE id = $1`,
            [rest.id]
          );
        }
        console.log(`  → Skipped (empty menu — marked doordash=delisted)`);
        progress.skipped++;
        consecutiveFailures = 0;
        consecutive429s = 0;
      } else if (dryRun) {
        console.log(`  → [DRY RUN] ${menu.categories.length} categories, ${itemCount} items`);
        progress.completed++;
        progress.totalItems += itemCount;
        consecutiveFailures = 0;
        consecutive429s = 0;
      } else {
        const count = await upsertMenu(rest.id, 'doordash', menu);
        await db.query('UPDATE restaurants SET last_synced_at = NOW() WHERE id = $1', [rest.id]);

        const elapsed = ((Date.now() - restStart) / 1000).toFixed(1);
        console.log(`  → ${count} items (${menu.categories.length} categories) — ${elapsed}s`);

        progress.completed++;
        progress.totalItems += count;
        progress.lastRestaurantId = rest.id;
        consecutiveFailures = 0;
        consecutive429s = 0;

        // Track for matching if this restaurant also has Seamless data
        if (rest.seamless_id) {
          matchedRestaurantIds.push(rest.id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  → FAILED: ${msg.substring(0, 120)}`);
      progress.failed++;
      consecutiveFailures++;

      // Handle 429 rate limiting with escalating cooldowns
      if (msg.includes('429')) {
        consecutive429s++;
        if (consecutive429s >= MAX_CONSECUTIVE_429) {
          console.log(`  ${consecutive429s} consecutive 429s — hard cooldown ${HARD_COOLDOWN_MS / 1000}s...`);
          await sleep(HARD_COOLDOWN_MS);
          consecutive429s = 0;
        } else {
          console.log(`  429 #${consecutive429s} — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s...`);
          await sleep(RATE_LIMIT_COOLDOWN_MS);
        }
      } else if (msg.includes('401') || msg.includes('403') || msg.includes('expired')) {
        // Auth error — try keep-alive, exit if it fails
        console.log('  Possible auth issue — attempting session keep-alive...');
        try {
          const browser = adapter.getBrowser();
          await browser.navigateHome();
          await sleep(3000);
          const recovered = await checkSessionHealth(adapter);
          if (!recovered) {
            console.error('\n*** Auth expired and could not be refreshed. Exiting for restart. ***');
            saveProgress(progress);
            process.exit(1);
          }
          console.log('  Session recovered via keep-alive. Continuing...');
          consecutiveFailures = 0;
        } catch {
          console.error('\n*** Auth recovery failed. Exiting for restart. ***');
          saveProgress(progress);
          process.exit(1);
        }
      } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Escalating backoff for non-429 errors
        const backoffIdx = Math.min(consecutiveFailures - MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAYS.length - 1);
        const backoff = BACKOFF_DELAYS[backoffIdx];
        console.log(`  ${consecutiveFailures} consecutive failures — backing off ${backoff / 1000}s...`);
        await sleep(backoff);
      }
    }

    // Save progress periodically
    if ((i + 1) % 10 === 0) {
      saveProgress(progress);
    }

    // Inter-restaurant delay (skip after last restaurant)
    if (i < restaurants.length - 1) {
      await sleep(randomDelay());
    }
  }

  // Final progress save
  saveProgress(progress);

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n=== Summary ===');
  console.log(`  Completed: ${progress.completed}`);
  console.log(`  Failed:    ${progress.failed}`);
  console.log(`  Skipped:   ${progress.skipped}`);
  console.log(`  Items:     ${progress.totalItems}`);
  console.log(`  Addresses: ${progress.enrichedAddresses} enriched`);
  console.log(`  Elapsed:   ${totalElapsed} min`);

  // Post-population: cross-platform matching
  if (!skipMatch && !dryRun && matchedRestaurantIds.length > 0) {
    console.log(`\n=== Running cross-platform item matching (${matchedRestaurantIds.length} restaurants) ===`);

    // Only match restaurants that have menu items on BOTH platforms
    const matchable = await db.query(
      `SELECT DISTINCT mi.restaurant_id
       FROM menu_items mi
       WHERE mi.restaurant_id = ANY($1)
         AND mi.platform = 'doordash'
         AND EXISTS (
           SELECT 1 FROM menu_items mi2
           WHERE mi2.restaurant_id = mi.restaurant_id
             AND mi2.platform = 'seamless'
         )`,
      [matchedRestaurantIds]
    );

    let totalMatches = 0;
    let totalUnmatched = 0;
    let totalPerfectPrice = 0;
    let totalSuspicious = 0;
    const suspiciousRestaurants: Array<{ id: string; name: string; count: number }> = [];

    for (const row of matchable.rows) {
      const result = await matchMenuItems(row.restaurant_id);
      totalMatches += result.matched;
      totalUnmatched += result.unmatched;

      // Validate match quality
      const validation = await validateMatches(row.restaurant_id);
      totalPerfectPrice += validation.perfectPrice;
      totalSuspicious += validation.suspicious.length;
      if (validation.suspicious.length > 0) {
        // Look up restaurant name for the report
        const nameResult = await db.query('SELECT canonical_name FROM restaurants WHERE id = $1', [row.restaurant_id]);
        suspiciousRestaurants.push({
          id: row.restaurant_id,
          name: nameResult.rows[0]?.canonical_name || row.restaurant_id,
          count: validation.suspicious.length,
        });
      }
    }

    console.log(`  Matchable restaurants: ${matchable.rows.length}`);
    console.log(`  Items matched: ${totalMatches}`);
    console.log(`  Items unmatched: ${totalUnmatched}`);
    console.log(`  Perfect price matches: ${totalPerfectPrice}/${totalPerfectPrice + totalSuspicious} (${totalPerfectPrice + totalSuspicious > 0 ? ((totalPerfectPrice / (totalPerfectPrice + totalSuspicious)) * 100).toFixed(1) : 0}%)`);
    if (suspiciousRestaurants.length > 0) {
      console.log(`\n  ⚠ ${suspiciousRestaurants.length} restaurants with price mismatches:`);
      for (const r of suspiciousRestaurants.slice(0, 20)) {
        console.log(`    ${r.name}: ${r.count} mismatched items`);
      }
      if (suspiciousRestaurants.length > 20) {
        console.log(`    ... and ${suspiciousRestaurants.length - 20} more`);
      }
    }
  }

  // DB state
  const counts = await db.query('SELECT platform, COUNT(*) as count FROM menu_items GROUP BY platform');
  const matchCount = await db.query('SELECT COUNT(*) as count FROM menu_items WHERE matched_item_id IS NOT NULL');
  console.log('\n=== DB State ===');
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
