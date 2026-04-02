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
 *
 * Requires an authenticated Seamless session (login via Settings page first).
 * Uses CDP port 9223 — can run alongside the server if server doesn't use Seamless browser.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { upsertMenu } from '../services/menu-upsert.js';
import { matchMenuItems } from '../services/matching.js';

// --- Config ---
const INTER_RESTAURANT_DELAY_MS = 5000;
const INTER_RESTAURANT_JITTER_MS = 3000;
const SESSION_CHECK_INTERVAL = 50; // Check auth every N restaurants
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAYS = [30_000, 60_000, 120_000]; // Escalating backoff on errors
const PROGRESS_FILE = path.resolve(process.cwd(), 'data', 'seamless-menu-progress.json');

// --- CLI args ---
const args = process.argv.slice(2);
const matchedOnly = args.includes('--matched-only');
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');
const skipMatch = args.includes('--skip-match');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const ridIdx = args.indexOf('--restaurant-id');
const singleRestaurantId = ridIdx !== -1 ? args[ridIdx + 1] : null;

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

  for (let i = 0; i < restaurants.length; i++) {
    const rest = restaurants[i];
    const restStart = Date.now();

    // Session health check every N restaurants
    if (i > 0 && i % SESSION_CHECK_INTERVAL === 0) {
      console.log(`\n[Health check] Verifying session... (${i}/${restaurants.length})`);
      const valid = await adapter.isSessionValid();
      if (!valid) {
        console.log('[Health check] Session expired. Attempting token refresh...');
        await adapter.refreshTokens();
        const browser = adapter.getBrowser();
        const token = await browser.getAuthToken();
        if (!token) {
          console.error('\n*** Auth expired. Re-authenticate via Settings page and re-run with --resume ***');
          console.log(`Progress: ${progress.completed} completed, ${progress.failed} failed, ${progress.skipped} skipped`);
          saveProgress(progress);
          process.exit(1);
        }
        console.log('[Health check] Token refreshed successfully.');
      } else {
        console.log('[Health check] Session OK.');
      }
    }

    try {
      console.log(`[${i + 1}/${restaurants.length}] ${rest.canonical_name} (${rest.seamless_id})...`);

      const menu = await adapter.getMenu(rest.seamless_id);
      const itemCount = menu.categories.reduce((a, c) => a + c.items.length, 0);

      if (itemCount === 0) {
        // Mark as delisted — restaurant exists in search but has no active menu
        if (!dryRun) {
          await db.query(
            `UPDATE restaurants SET platform_status = jsonb_set(COALESCE(platform_status, '{}'), '{seamless}', '"delisted"') WHERE id = $1`,
            [rest.id]
          );
        }
        console.log(`  → Skipped (empty menu — marked seamless=delisted)`);
        progress.skipped++;
        consecutiveFailures = 0;
      } else if (dryRun) {
        console.log(`  → [DRY RUN] ${menu.categories.length} categories, ${itemCount} items`);
        progress.completed++;
        progress.totalItems += itemCount;
        consecutiveFailures = 0;
      } else {
        const count = await upsertMenu(rest.id, 'seamless', menu);
        await db.query('UPDATE restaurants SET last_synced_at = NOW() WHERE id = $1', [rest.id]);

        const elapsed = ((Date.now() - restStart) / 1000).toFixed(1);
        console.log(`  → ${count} items (${menu.categories.length} categories) — ${elapsed}s`);

        progress.completed++;
        progress.totalItems += count;
        progress.lastRestaurantId = rest.id;
        consecutiveFailures = 0;

        // Track for matching if this restaurant also has DoorDash data
        if (rest.doordash_id) {
          matchedRestaurantIds.push(rest.id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  → FAILED: ${msg.substring(0, 120)}`);
      progress.failed++;
      consecutiveFailures++;

      // Check if this is an auth error
      if (msg.includes('401') || msg.includes('403') || msg.includes('expired')) {
        console.log('  Possible auth issue — attempting token refresh...');
        await adapter.refreshTokens();
        const browser = adapter.getBrowser();
        const token = await browser.getAuthToken();
        if (!token) {
          console.error('\n*** Auth expired. Re-authenticate via Settings page and re-run with --resume ***');
          saveProgress(progress);
          process.exit(1);
        }
        console.log('  Token refreshed. Continuing...');
        consecutiveFailures = 0;
      } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Escalating backoff
        const backoff = BACKOFF_DELAYS[Math.min(consecutiveFailures - MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAYS.length - 1)];
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
