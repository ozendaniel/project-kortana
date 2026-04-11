/**
 * Bulk-fetch Seamless menus and populate the DB.
 *
 * Usage:
 *   npx tsx src/scripts/populate-seamless-menus.ts                    # All Seamless restaurants
 *   npx tsx src/scripts/populate-seamless-menus.ts --matched-only     # Only cross-platform matched (533)
 *   npx tsx src/scripts/populate-seamless-menus.ts --limit 10         # First 10 restaurants
 *   npx tsx src/scripts/populate-seamless-menus.ts --resume           # Skip recently synced (24h)
 *   npx tsx src/scripts/populate-seamless-menus.ts --restaurant-id X  # Single restaurant
 *   npx tsx src/scripts/populate-seamless-menus.ts --dry-run          # Fetch but don't write to DB
 *   npx tsx src/scripts/populate-seamless-menus.ts --skip-match       # Don't run item matching after
 *   npx tsx src/scripts/populate-seamless-menus.ts --sustained        # Longer delays for multi-hour runs
 *   npx tsx src/scripts/populate-seamless-menus.ts --concurrency 2   # Scrape 2 restaurants at once
 *
 * Requires an authenticated Seamless session (login via Settings page first).
 * Uses CDP port 9223 — can run alongside the server if server doesn't use Seamless browser.
 *
 * For long unattended runs, use the wrapper script:
 *   bash server/scripts/run-seamless-populate.sh
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { upsertMenu } from '../services/menu-upsert.js';
import { matchMenuItems, validateMatches } from '../services/matching.js';
import { acquireLock } from '../utils/process-lock.js';

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
const concurrencyIdx = args.indexOf('--concurrency');
const concurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1], 10) : 1;

// --- Config (adjusted for sustained mode) ---
const INTER_RESTAURANT_DELAY_MS = sustained ? 8000 : 5000;
const INTER_RESTAURANT_JITTER_MS = sustained ? 4000 : 3000;
const SESSION_CHECK_INTERVAL = 50; // Check auth every N restaurants
const SESSION_KEEPALIVE_INTERVAL = sustained ? 100 : 200; // Navigate to seamless.com to refresh token
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAYS = [30_000, 60_000, 120_000]; // Escalating backoff on errors
const PROGRESS_FILE = path.resolve(process.cwd(), 'data', 'seamless-menu-progress.json');

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
  lastRestaurantId: string | null;
}

function saveProgress(state: ProgressState): void {
  try {
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

async function main() {
  console.log('=== Seamless Menu Bulk Population ===\n');
  if (dryRun) console.log('*** DRY RUN — no DB writes ***\n');

  // Acquire the populate lock so the dev server (and any other tools) know
  // to skip initializing the Seamless adapter while we're running.
  // Cleanup on exit is registered automatically.
  try {
    acquireLock('seamless-populate', { script: 'populate-seamless-menus.ts' });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Build query for target restaurants
  const conditions: string[] = [
    'seamless_id IS NOT NULL',
    `(platform_status->>'seamless' IS NULL OR platform_status->>'seamless' != 'delisted')`,
  ];
  const params: unknown[] = [];

  if (singleRestaurantId) {
    params.push(singleRestaurantId);
    conditions.push(`id = $${params.length}`);
  }

  if (matchedOnly) {
    conditions.push('doordash_id IS NOT NULL');
  }

  if (resume) {
    conditions.push(`(last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '24 hours')`);
  }

  let query = `SELECT id, canonical_name, seamless_id, doordash_id, last_synced_at
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
  const totalSeamless = await db.query('SELECT COUNT(*) as count FROM restaurants WHERE seamless_id IS NOT NULL');
  const totalMatched = await db.query('SELECT COUNT(*) as count FROM restaurants WHERE seamless_id IS NOT NULL AND doordash_id IS NOT NULL');

  console.log(`Target: ${restaurants.length} restaurants`);
  console.log(`  (Total Seamless: ${totalSeamless.rows[0].count}, Matched: ${totalMatched.rows[0].count})`);
  if (matchedOnly) console.log('  Mode: matched-only');
  if (resume) console.log('  Mode: resume (skipping recently synced)');
  if (sustained) console.log('  Mode: sustained (longer delays, frequent keep-alive)');
  if (concurrency > 1) console.log(`  Mode: concurrent (${concurrency} workers)`);
  console.log();

  // Initialize adapter
  console.log('Initializing Seamless adapter...');
  const adapter = new SeamlessAdapter();
  await adapter.initialize({
    email: process.env.SEAMLESS_EMAIL || '',
    password: process.env.SEAMLESS_PASSWORD || '',
  });

  if (adapter.getStatus() !== 'authenticated') {
    console.error('Seamless session not authenticated. Please login via Settings page first.');
    process.exit(1);
  }
  console.log('Seamless adapter ready.\n');

  // Track progress
  const progress: ProgressState = {
    startedAt: new Date().toISOString(),
    completed: 0,
    failed: 0,
    skipped: 0,
    totalItems: 0,
    lastRestaurantId: null,
  };

  let consecutiveFailures = 0;
  const matchedRestaurantIds: string[] = []; // For post-population matching
  const startTime = Date.now();
  let processedCount = 0; // Total restaurants attempted (for health check scheduling)

  /** Process a single restaurant. Returns true on success/skip, false on failure. */
  async function processRestaurant(rest: typeof restaurants[0], label: string): Promise<boolean> {
    const restStart = Date.now();
    try {
      console.log(`${label} ${rest.canonical_name} (${rest.seamless_id})...`);

      const menu = await adapter.getMenu(rest.seamless_id);
      const itemCount = menu.categories.reduce((a, c) => a + c.items.length, 0);

      if (itemCount === 0) {
        if (!dryRun) {
          await db.query(
            `UPDATE restaurants SET platform_status = jsonb_set(COALESCE(platform_status, '{}'), '{seamless}', '"delisted"') WHERE id = $1`,
            [rest.id]
          );
        }
        console.log(`  ${label} → Skipped (empty menu — marked seamless=delisted)`);
        progress.skipped++;
        return true;
      } else if (dryRun) {
        console.log(`  ${label} → [DRY RUN] ${menu.categories.length} categories, ${itemCount} items`);
        progress.completed++;
        progress.totalItems += itemCount;
        return true;
      } else {
        const count = await upsertMenu(rest.id, 'seamless', menu);
        await db.query('UPDATE restaurants SET last_synced_at = NOW() WHERE id = $1', [rest.id]);

        const elapsed = ((Date.now() - restStart) / 1000).toFixed(1);
        console.log(`  ${label} → ${count} items (${menu.categories.length} categories) — ${elapsed}s`);

        progress.completed++;
        progress.totalItems += count;
        progress.lastRestaurantId = rest.id;

        if (rest.doordash_id) {
          matchedRestaurantIds.push(rest.id);
        }
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${label} → FAILED: ${msg.substring(0, 120)}`);
      // Mark for re-run so we can easily find and retry failed restaurants
      if (!dryRun) {
        await db.query(
          `UPDATE restaurants SET platform_status = jsonb_set(COALESCE(platform_status, '{}'), '{seamless}', '"scrape_failed"') WHERE id = $1`,
          [rest.id]
        ).catch(() => {});
      }
      progress.failed++;
      return false;
    }
  }

  /** Run session keep-alive (must not run concurrently with scraping). */
  async function sessionKeepAlive(): Promise<boolean> {
    console.log(`\n[Keep-alive] Refreshing session... (${processedCount}/${restaurants.length})`);
    try {
      const browser = adapter.getBrowser();
      await browser.navigateHome();
      await sleep(3000);
      await adapter.refreshTokens();
      const token = await browser.getAuthToken();
      if (token) {
        console.log('[Keep-alive] Session token refreshed.');
        return true;
      }
      console.log('[Keep-alive] WARNING: No token after refresh.');
      return false;
    } catch (err) {
      console.log(`[Keep-alive] Failed: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
      return false;
    }
  }

  /** Run session health check (must not run concurrently with scraping). */
  async function sessionHealthCheck(): Promise<boolean> {
    console.log(`\n[Health check] Verifying session... (${processedCount}/${restaurants.length})`);
    const valid = await adapter.isSessionValid();
    if (!valid) {
      console.log('[Health check] Session expired. Attempting keep-alive...');
      const recovered = await sessionKeepAlive();
      if (!recovered) {
        console.error('\n*** Auth expired and could not be refreshed. Exiting for restart. ***');
        saveProgress(progress);
        process.exit(1);
      }
      console.log('[Health check] Session recovered.');
    } else {
      console.log('[Health check] Session OK.');
    }
    return true;
  }

  // --- Main processing loop ---
  let queueIndex = 0;

  while (queueIndex < restaurants.length) {
    // Session keep-alive / health check (runs between batches, not during)
    if (processedCount > 0 && processedCount % SESSION_KEEPALIVE_INTERVAL === 0) {
      await sessionKeepAlive();
    } else if (processedCount > 0 && processedCount % SESSION_CHECK_INTERVAL === 0) {
      await sessionHealthCheck();
    }

    // Build a batch of up to `concurrency` restaurants
    const batch: typeof restaurants = [];
    while (batch.length < concurrency && queueIndex < restaurants.length) {
      batch.push(restaurants[queueIndex++]);
    }

    // Process batch concurrently
    const results = await Promise.all(
      batch.map((rest, idx) => {
        const globalIdx = queueIndex - batch.length + idx + 1;
        const label = `[${globalIdx}/${restaurants.length}]`;
        return processRestaurant(rest, label);
      })
    );

    // Track failures for backoff
    const batchFailures = results.filter(r => !r).length;
    if (batchFailures === 0) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += batchFailures;

      // Check for auth errors — attempt recovery
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoff = BACKOFF_DELAYS[Math.min(consecutiveFailures - MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAYS.length - 1)];
        console.log(`  ${consecutiveFailures} consecutive failures — backing off ${backoff / 1000}s...`);
        await sleep(backoff);
      }
    }

    processedCount += batch.length;

    // Save progress periodically
    if (processedCount % 10 < concurrency) {
      saveProgress(progress);
    }

    // Inter-batch delay (skip after last batch)
    if (queueIndex < restaurants.length) {
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
  console.log(`  Elapsed:   ${totalElapsed} min`);

  // Post-population: cross-platform matching
  if (!skipMatch && !dryRun && matchedRestaurantIds.length > 0) {
    console.log(`\n=== Running cross-platform item matching (${matchedRestaurantIds.length} restaurants) ===`);

    // Only match restaurants that have menu items on BOTH platforms
    const matchable = await db.query(
      `SELECT DISTINCT mi.restaurant_id
       FROM menu_items mi
       WHERE mi.restaurant_id = ANY($1)
         AND mi.platform = 'seamless'
         AND EXISTS (
           SELECT 1 FROM menu_items mi2
           WHERE mi2.restaurant_id = mi.restaurant_id
             AND mi2.platform = 'doordash'
         )`,
      [matchedRestaurantIds]
    );

    let totalMatches = 0;
    let totalUnmatched = 0;

    for (const row of matchable.rows) {
      const result = await matchMenuItems(row.restaurant_id);
      totalMatches += result.matched;
      totalUnmatched += result.unmatched;
    }

    console.log(`  Matchable restaurants: ${matchable.rows.length}`);
    console.log(`  Items matched: ${totalMatches}`);
    console.log(`  Items unmatched: ${totalUnmatched}`);
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
