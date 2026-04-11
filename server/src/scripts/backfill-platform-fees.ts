/**
 * Backfill the restaurants.platform_fees cache for matched restaurants without
 * re-fetching menus.
 *
 * For Seamless: calls GET /restaurants/{id} via the Seamless adapter.
 * For DoorDash: calls the storepageFeed GraphQL query (same one the menu
 *               populate uses, but we only keep the fee fields here).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-platform-fees.ts                    # All matched restaurants
 *   npx tsx src/scripts/backfill-platform-fees.ts --restaurant-id X  # Single
 *   npx tsx src/scripts/backfill-platform-fees.ts --platform seamless
 *   npx tsx src/scripts/backfill-platform-fees.ts --limit 10
 *   npx tsx src/scripts/backfill-platform-fees.ts --resume            # Skip restaurants already having platform_fees populated
 *
 * Requires the dev server to be STOPPED (uses the same CDP ports). Pre-spawns
 * headful Chrome on CDP 9224 for DoorDash.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { SeamlessAdapter } from '../adapters/seamless/adapter.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { extractDoorDashFees, type CachedFees } from '../services/fees.js';
import { findChromePath, getProfileDir, getChromeArgs, cleanProfileLocks } from '../utils/chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, '..', 'adapters', 'doordash', 'queries');

const args = process.argv.slice(2);
const platformIdx = args.indexOf('--platform');
const onlyPlatform = platformIdx !== -1 ? args[platformIdx + 1] : null;
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
  console.log('=== Backfill platform_fees ===\n');

  // Build target list
  const conditions: string[] = [
    'doordash_id IS NOT NULL',
    'seamless_id IS NOT NULL',
  ];
  const params: unknown[] = [];
  if (singleRid) {
    params.push(singleRid);
    conditions.push(`id = $${params.length}`);
  }
  if (resume) {
    conditions.push(`(platform_fees = '{}' OR platform_fees IS NULL)`);
  }

  let query = `SELECT id, canonical_name, doordash_id, seamless_id, platform_fees
    FROM restaurants
    WHERE ${conditions.join(' AND ')}
    ORDER BY canonical_name`;
  if (limit > 0) query += ` LIMIT ${limit}`;

  const { rows: restaurants } = await db.query(query, params);
  console.log(`Target: ${restaurants.length} matched restaurants`);
  if (onlyPlatform) console.log(`Platform filter: ${onlyPlatform}\n`);
  else console.log();

  // Init adapters
  let seamless: SeamlessAdapter | null = null;
  let doordash: DoorDashAdapter | null = null;
  let ddChromeProc: ReturnType<typeof spawn> | null = null;

  if (!onlyPlatform || onlyPlatform === 'seamless') {
    if (!process.env.SEAMLESS_EMAIL) {
      console.warn('SEAMLESS_EMAIL not set — skipping Seamless');
    } else {
      console.log('Initializing Seamless adapter...');
      seamless = new SeamlessAdapter();
      await seamless.initialize({
        email: process.env.SEAMLESS_EMAIL,
        password: process.env.SEAMLESS_PASSWORD,
      });
      if (seamless.getStatus() !== 'authenticated') {
        console.error('Seamless session not authenticated. Log in via Settings portal first.');
        seamless = null;
      } else {
        console.log('Seamless ready.');
      }
    }
  }

  if (!onlyPlatform || onlyPlatform === 'doordash') {
    if (!process.env.DOORDASH_EMAIL) {
      console.warn('DOORDASH_EMAIL not set — skipping DoorDash');
    } else {
      console.log('Pre-spawning Chrome headful on CDP 9224 for DoorDash...');
      const CDP_PORT = 9224;
      // Kill stale
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
      ddChromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
      await sleep(3000);

      try {
        const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
        if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
      } catch {
        console.error(`Chrome failed to start on ${CDP_PORT}`);
        process.exit(1);
      }

      console.log('Initializing DoorDash adapter...');
      doordash = new DoorDashAdapter();
      await doordash.initialize({ email: process.env.DOORDASH_EMAIL });
      if (doordash.getStatus() !== 'authenticated') {
        console.error('DoorDash session not authenticated. Log in via Settings portal first.');
        doordash = null;
      } else {
        // Load DD homepage for SPA context
        const mainPage = doordash.getBrowser().getPage();
        if (mainPage) {
          console.log('Loading DoorDash homepage for SPA context...');
          await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
          await sleep(5000);
        }
        console.log('DoorDash ready.');
      }
    }
  }

  const storeQuery = doordash ? loadQuery('storepageFeed.graphql') : '';

  let slOk = 0, slFail = 0;
  let ddOk = 0, ddFail = 0;
  const startTime = Date.now();

  for (let i = 0; i < restaurants.length; i++) {
    const rest = restaurants[i];
    const progress = `[${i + 1}/${restaurants.length}]`;

    // Seamless
    if (seamless) {
      try {
        const fees = await seamless.getRestaurantFees(rest.seamless_id);
        if (fees) {
          await db.query(
            `UPDATE restaurants SET platform_fees = jsonb_set(COALESCE(platform_fees, '{}'), '{seamless}', $1::jsonb) WHERE id = $2`,
            [JSON.stringify(fees), rest.id]
          );
          console.log(`${progress} ${rest.canonical_name} SL: del $${(fees.deliveryFeeCents/100).toFixed(2)}, svc ${(fees.serviceFeeRate*100).toFixed(0)}%, toll $${(fees.serviceTollCents/100).toFixed(2)}`);
          slOk++;
        } else {
          slFail++;
        }
      } catch (err) {
        console.warn(`${progress} ${rest.canonical_name} SL failed: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
        slFail++;
      }
      await sleep(1000 + Math.random() * 500);
    }

    // DoorDash
    if (doordash) {
      try {
        const browser = doordash.getBrowser();
        const result = await browser.mainTabGraphqlQuery<any>('storepageFeed', storeQuery, {
          storeId: rest.doordash_id,
          menuId: null,
          isMerchantPreview: false,
          fulfillmentType: 'Delivery',
          cursor: null,
          scheduledTime: null,
          entryPoint: 'HomePage',
        }, 1);
        const storeHeader = result?.data?.storepageFeed?.storeHeader;
        const fees = storeHeader ? extractDoorDashFees(storeHeader) : null;
        if (fees) {
          await db.query(
            `UPDATE restaurants SET platform_fees = jsonb_set(COALESCE(platform_fees, '{}'), '{doordash}', $1::jsonb) WHERE id = $2`,
            [JSON.stringify(fees), rest.id]
          );
          console.log(`${progress} ${rest.canonical_name} DD: del $${(fees.deliveryFeeCents/100).toFixed(2)}, svc ${(fees.serviceFeeRate*100).toFixed(0)}%`);
          ddOk++;
        } else {
          ddFail++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`${progress} ${rest.canonical_name} DD failed: ${msg.substring(0, 80)}`);
        ddFail++;
      }
      await sleep(2500 + Math.random() * 1500);  // DD aggressive rate limiting
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Done in ${elapsed} min ===`);
  console.log(`Seamless: ${slOk} ok, ${slFail} failed`);
  console.log(`DoorDash: ${ddOk} ok, ${ddFail} failed`);

  if (ddChromeProc) {
    try { ddChromeProc.kill(); } catch {}
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
