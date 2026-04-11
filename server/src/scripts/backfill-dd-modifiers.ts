/**
 * Backfill modifier_groups + menu_platform_id on existing DoorDash menu_items
 * without re-running the full menu populate.
 *
 * Two-stage process:
 *   1. For each matched restaurant, call storepageFeed ONCE to get menuBook.id
 *      and identify which items have quickAddContext.isEligible === false.
 *   2. For each such item, call itemPage to fetch the modifier structure,
 *      store normalized modifier_groups on menu_items.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-dd-modifiers.ts                    # All matched restaurants
 *   npx tsx src/scripts/backfill-dd-modifiers.ts --restaurant-id X  # Single
 *   npx tsx src/scripts/backfill-dd-modifiers.ts --limit 10
 *   npx tsx src/scripts/backfill-dd-modifiers.ts --resume           # Skip items that already have modifier_groups
 *
 * Requires dev server STOPPED. Pre-spawns headful Chrome on CDP 9224.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { findChromePath, getProfileDir, getChromeArgs, cleanProfileLocks } from '../utils/chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, '..', 'adapters', 'doordash', 'queries');

const args = process.argv.slice(2);
const ridIdx = args.indexOf('--restaurant-id');
const singleRid = ridIdx !== -1 ? args[ridIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
const resume = args.includes('--resume');

function loadQuery(filename: string): string {
  const raw = fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
  const lines = raw.split('\n');
  const queryStart = lines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
  return lines.slice(queryStart).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== Backfill DoorDash modifier_groups ===\n');

  // Target: matched restaurants with DD menu items
  const conditions: string[] = [
    'r.doordash_id IS NOT NULL',
    'r.seamless_id IS NOT NULL',
    `EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.platform = 'doordash')`,
  ];
  const params: unknown[] = [];
  if (singleRid) {
    params.push(singleRid);
    conditions.push(`r.id = $${params.length}`);
  }

  let q = `SELECT r.id, r.canonical_name, r.doordash_id
    FROM restaurants r
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.canonical_name`;
  if (limit > 0) q += ` LIMIT ${limit}`;

  const { rows: restaurants } = await db.query(q, params);
  console.log(`Target: ${restaurants.length} matched restaurants\n`);

  // Pre-spawn Chrome headful
  const CDP_PORT = 9224;
  console.log('Pre-spawning Chrome headful on CDP 9224...');
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (resp.ok) {
      const { execSync } = await import('child_process');
      const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${CDP_PORT}"`, { encoding: 'utf-8' });
      const pidMatch = out.trim().match(/\s(\d+)\s*$/m);
      if (pidMatch) {
        execSync(`taskkill /PID ${pidMatch[1]} /T /F`, { stdio: 'ignore' });
        console.log(`Killed stale Chrome (PID ${pidMatch[1]})`);
        await sleep(2000);
      }
    }
  } catch {}

  const chromePath = findChromePath();
  const profileDir = getProfileDir('doordash');
  cleanProfileLocks(profileDir);
  const chromeArgs = getChromeArgs({ cdpPort: CDP_PORT, profileDir, headless: false });
  const chromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
  await sleep(3000);

  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
  } catch {
    console.error(`Chrome failed to start on ${CDP_PORT}`);
    process.exit(1);
  }

  console.log('Initializing DoorDash adapter...');
  const adapter = new DoorDashAdapter();
  if (!process.env.DOORDASH_EMAIL) {
    console.error('DOORDASH_EMAIL not set');
    process.exit(1);
  }
  await adapter.initialize({ email: process.env.DOORDASH_EMAIL });
  if (adapter.getStatus() !== 'authenticated') {
    console.error('DoorDash session not authenticated. Log in via Settings portal first.');
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

  const storeQuery = loadQuery('storepageFeed.graphql');
  const browser = adapter.getBrowser();

  let totalItemsNeeded = 0;
  let totalItemsCaptured = 0;
  let totalItemsFailed = 0;
  let restaurantsSkipped = 0;
  const startTime = Date.now();

  for (let i = 0; i < restaurants.length; i++) {
    const rest = restaurants[i];
    const progress = `[${i + 1}/${restaurants.length}]`;

    try {
      // Stage 1: storepageFeed to identify items needing modifiers + get menuId
      const result = await browser.mainTabGraphqlQuery<any>('storepageFeed', storeQuery, {
        storeId: rest.doordash_id,
        menuId: null,
        isMerchantPreview: false,
        fulfillmentType: 'Delivery',
        cursor: null,
        scheduledTime: null,
        entryPoint: 'HomePage',
      }, 1);

      const feed = result?.data?.storepageFeed;
      const menuPlatformId = feed?.menuBook?.id || null;
      const itemLists = feed?.itemLists || [];

      // Store menu_platform_id on all DD items for this restaurant
      if (menuPlatformId) {
        await db.query(
          `UPDATE menu_items SET menu_platform_id = $1
           WHERE restaurant_id = $2 AND platform = 'doordash' AND (menu_platform_id IS NULL OR menu_platform_id = '')`,
          [menuPlatformId, rest.id]
        );
      }

      // Collect items needing modifiers
      const needed = new Set<string>();
      for (const cat of itemLists) {
        for (const item of (cat.items || [])) {
          if (item.quickAddContext && item.quickAddContext.isEligible === false) {
            needed.add(item.id);
          }
        }
      }

      if (needed.size === 0) {
        console.log(`${progress} ${rest.canonical_name}: 0 items need modifiers, menuId=${menuPlatformId}`);
        restaurantsSkipped++;
        await sleep(2000 + Math.random() * 1000);
        continue;
      }

      // Resume mode: skip items that already have modifier_groups
      let toFetch = Array.from(needed);
      if (resume) {
        const existingRes = await db.query(
          `SELECT platform_item_id FROM menu_items
           WHERE restaurant_id = $1 AND platform = 'doordash'
             AND platform_item_id = ANY($2::text[])
             AND modifier_groups IS NOT NULL`,
          [rest.id, toFetch]
        );
        const existing = new Set(existingRes.rows.map(r => r.platform_item_id));
        const before = toFetch.length;
        toFetch = toFetch.filter(id => !existing.has(id));
        if (before !== toFetch.length) {
          console.log(`${progress} ${rest.canonical_name}: ${before - toFetch.length} items already have modifiers, fetching ${toFetch.length} more`);
        }
      }

      console.log(`${progress} ${rest.canonical_name}: fetching modifiers for ${toFetch.length}/${needed.size} items (menuId=${menuPlatformId})`);
      totalItemsNeeded += toFetch.length;

      // Stage 2: itemPage for each item needing modifiers
      for (const platformItemId of toFetch) {
        try {
          const groups = await adapter.fetchItemModifiers(rest.doordash_id, platformItemId, menuPlatformId);
          if (groups.length > 0) {
            await db.query(
              `UPDATE menu_items SET modifier_groups = $1::jsonb
               WHERE restaurant_id = $2 AND platform = 'doordash' AND platform_item_id = $3`,
              [JSON.stringify(groups), rest.id, platformItemId]
            );
            totalItemsCaptured++;
            const groupNames = groups.map(g => `${g.name}(${g.options.length})`).join(', ');
            console.log(`    ✓ ${platformItemId}: ${groupNames}`);
          } else {
            totalItemsFailed++;
            console.log(`    ✗ ${platformItemId}: no modifier groups returned`);
          }
        } catch (err) {
          totalItemsFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`    ✗ ${platformItemId}: ${msg.substring(0, 120)}`);
        }
        await sleep(2500 + Math.random() * 1500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${progress} ${rest.canonical_name}: storepageFeed failed — ${msg.substring(0, 150)}`);
    }

    // Inter-restaurant cooldown
    if (i < restaurants.length - 1) {
      await sleep(3000 + Math.random() * 2000);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log('=== Modifier Backfill Complete ===');
  console.log(`${'='.repeat(60)}`);
  console.log(`Time elapsed:               ${elapsed} min`);
  console.log(`Restaurants processed:      ${restaurants.length}`);
  console.log(`  Skipped (no mod items):   ${restaurantsSkipped}`);
  console.log(`Items needing modifiers:    ${totalItemsNeeded}`);
  console.log(`  Captured successfully:    ${totalItemsCaptured}`);
  console.log(`  Failed:                   ${totalItemsFailed}`);

  try { chromeProc.kill(); } catch {}
  process.exit(0);
}

main().catch(err => {
  console.error('[Backfill-DD-Modifiers] Fatal error:', err);
  process.exit(1);
});
