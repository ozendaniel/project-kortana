/**
 * Bulk discover DoorDash restaurants across Manhattan via grid search.
 *
 * Usage:
 *   npx tsx src/scripts/discover-doordash.ts           # Pass 1: grid search
 *   npx tsx src/scripts/discover-doordash.ts --enrich   # Pass 2: fetch real addresses
 *
 * Must run with server stopped (uses CDP port 9224).
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { DoorDashAdapter } from '../adapters/doordash/adapter.js';
import { cleanRestaurantName } from '../utils/nameCleaner.js';
import { findChromePath, getProfileDir, getChromeArgs } from '../utils/chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, '..', 'adapters', 'doordash', 'queries');

function loadQuery(filename: string): string {
  const raw = fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
  const lines = raw.split('\n');
  const queryStart = lines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
  return lines.slice(queryStart).join('\n');
}

// Manhattan grid: same as Seamless discovery
const GRID_POINTS: Array<{ lat: number; lng: number; label: string }> = [];

const LAT_START = 40.700;
const LAT_END = 40.820;
const LAT_STEP = 0.018;

const LNG_START = -74.020;
const LNG_END = -73.930;
const LNG_STEP = 0.022;

for (let lat = LAT_START; lat <= LAT_END; lat += LAT_STEP) {
  for (let lng = LNG_START; lng <= LNG_END; lng += LNG_STEP) {
    GRID_POINTS.push({
      lat: Math.round(lat * 1000000) / 1000000,
      lng: Math.round(lng * 1000000) / 1000000,
      label: `(${lat.toFixed(3)}, ${lng.toFixed(3)})`,
    });
  }
}

async function upsertRestaurant(rest: {
  platformId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  cuisines: string[];
  rating?: number;
  imageUrl?: string;
  platformUrl: string;
}): Promise<'inserted' | 'updated'> {
  const cleanName = cleanRestaurantName(rest.name);

  // For DoorDash search results, lat/lng is approximate (the search grid point).
  // Use COALESCE to avoid overwriting real lat/lng from enrichment.
  const result = await db.query(
    `INSERT INTO restaurants (canonical_name, address, lat, lng, cuisine_tags, doordash_id, doordash_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (doordash_id) WHERE doordash_id IS NOT NULL
     DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       cuisine_tags = EXCLUDED.cuisine_tags,
       doordash_url = EXCLUDED.doordash_url,
       address = CASE WHEN restaurants.address IS NULL OR restaurants.address = '' THEN EXCLUDED.address ELSE restaurants.address END,
       lat = CASE WHEN restaurants.address IS NULL OR restaurants.address = '' THEN EXCLUDED.lat ELSE restaurants.lat END,
       lng = CASE WHEN restaurants.address IS NULL OR restaurants.address = '' THEN EXCLUDED.lng ELSE restaurants.lng END
     RETURNING (xmax = 0) AS is_insert`,
    [cleanName, rest.address, rest.lat, rest.lng, rest.cuisines, rest.platformId, rest.platformUrl]
  );

  return result.rows[0]?.is_insert ? 'inserted' : 'updated';
}

/** Parse card.store facets from DoorDash homePageFacetFeed response */
function parseStoresFromFeed(feed: any): Array<{
  platformId: string; name: string; cuisines: string[];
  rating?: number; deliveryTime?: string; imageUrl?: string; platformUrl: string;
}> {
  const stores: Array<any> = [];
  if (!feed?.body) return stores;

  for (const section of feed.body) {
    if (!section.body) continue;
    for (const facet of section.body) {
      const compId = facet.component?.id;
      if (compId !== 'row.store' && compId !== 'card.store') continue;

      let customData: any = {};
      try {
        customData = typeof facet.custom === 'string' ? JSON.parse(facet.custom) : (facet.custom || {});
      } catch { /* not valid JSON */ }

      const storeId = customData.store_id;
      const name = facet.text?.title;
      if (!storeId || !name) continue;

      let platformUrl = `https://www.doordash.com/store/${storeId}`;
      try {
        const clickData = typeof facet.events?.click?.data === 'string'
          ? JSON.parse(facet.events.click.data) : facet.events?.click?.data;
        if (clickData?.uri) platformUrl = `https://www.doordash.com/${clickData.uri}`;
      } catch { /* use default */ }

      const textCustomMap: Record<string, string> = {};
      if (Array.isArray(facet.text?.custom)) {
        for (const kv of facet.text.custom) {
          if (kv.key && kv.value) textCustomMap[kv.key] = kv.value;
        }
      }
      const etaStr = textCustomMap['eta_display_string'] || facet.text?.description || '';
      const timeMatch = etaStr.match(/(\d+\s*min)/);

      const cuisineStr = (facet.text?.description || '').replace(/^\s*•\s*/, '').replace(/\d.*/, '').trim();
      const cuisines = cuisineStr ? cuisineStr.split(/\s*,\s*/).filter(Boolean) : [];

      stores.push({
        platformId: String(storeId),
        name,
        cuisines,
        rating: customData.rating?.average_rating,
        deliveryTime: timeMatch ? timeMatch[1] : undefined,
        imageUrl: facet.images?.main?.uri,
        platformUrl,
      });
    }
  }
  return stores;
}

async function runGridSearch(adapter: DoorDashAdapter) {
  console.log(`[Discover-DD] Starting feed pagination (bypassing API tab — using main tab)`);

  const browser = adapter.getBrowser();
  const searchQuery = loadQuery('homePageFacetFeed.graphql');

  let totalInserted = 0;
  let totalUpdated = 0;
  const seenIds = new Set<string>();
  let cursor = '';
  let page = 0;
  const MAX_PAGES = 20;

  // Navigate main tab to DoorDash homepage with full SPA load
  // This sets cookies, CSRF tokens, and delivery context that the GraphQL endpoint needs
  const mainPage = browser.getPage();
  if (mainPage) {
    console.log('[Discover-DD] Loading DoorDash homepage for full context...');
    await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Discover-DD] Homepage loaded. Starting feed queries.');
  }

  // Paginate the feed from the user's current default address
  while (page < MAX_PAGES) {
    page++;
    const progress = `[Page ${page}/${MAX_PAGES}]`;

    try {
      const result = await browser.mainTabGraphqlQuery<any>('homePageFacetFeed', searchQuery, {
        cursor,
        filterQuery: '',
        displayHeader: false,
        isDebug: false,
        cuisineFilterVerticalIds: '',
      }, 1); // maxRetries=1

      const feed = result?.data?.homePageFacetFeed;

      // Debug: show response structure
      if (page === 1) {
        console.log(`${progress} Feed body: ${feed?.body ? `${feed.body.length} sections` : 'null'}`);
        if (feed?.body) {
          for (const sec of feed.body) {
            const types = new Map<string, number>();
            for (const f of (sec.body || [])) {
              const id = f.component?.id || 'unknown';
              types.set(id, (types.get(id) || 0) + 1);
            }
            console.log(`  Section: ${sec.body?.length || 0} items -`, Object.fromEntries(types));
          }
        } else {
          console.log(`  Raw keys:`, result ? Object.keys(result) : 'null');
          console.log(`  Data keys:`, result?.data ? Object.keys(result.data) : 'null');
          const raw = JSON.stringify(result).substring(0, 500);
          console.log(`  Response preview: ${raw}`);
        }
      }

      const stores = parseStoresFromFeed(feed);

      if (stores.length === 0) {
        console.log(`${progress} No more stores in feed. Stopping.`);
        break;
      }

      let pointNew = 0;
      let pointUpdated = 0;

      for (const store of stores) {
        if (seenIds.has(store.platformId)) continue;
        seenIds.add(store.platformId);

        const action = await upsertRestaurant({
          ...store,
          address: '',
          lat: 40.748, // default address approximate
          lng: -73.997,
        });

        if (action === 'inserted') { pointNew++; totalInserted++; }
        else { pointUpdated++; totalUpdated++; }
      }

      console.log(
        `${progress} ${stores.length} stores, ${pointNew} new, ${pointUpdated} updated (${seenIds.size} unique total)`
      );

      // Check for next page cursor
      const nextCursor = feed?.page?.nextCursor || feed?.page?.cursor;
      if (!nextCursor || nextCursor === cursor) {
        console.log(`${progress} No next cursor. Done.`);
        break;
      }
      cursor = nextCursor;
    } catch (err) {
      console.error(`${progress} FAILED -`, err instanceof Error ? err.message : err);

      if (err instanceof Error && err.message.includes('429')) {
        console.log(`${progress} Rate limited — cooling down 30s...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      break;
    }

    // Rate limit: 6s + random jitter
    await new Promise(resolve => setTimeout(resolve, 6000 + Math.random() * 2000));
  }

  const dbCount = await db.query('SELECT COUNT(*) FROM restaurants WHERE doordash_id IS NOT NULL');
  console.log('\n=== Discovery Complete ===');
  console.log(`Pages fetched: ${page}`);
  console.log(`Unique restaurants found: ${seenIds.size}`);
  console.log(`New inserted: ${totalInserted}`);
  console.log(`Updated: ${totalUpdated}`);
  console.log(`Total DoorDash restaurants in DB: ${dbCount.rows[0].count}`);
}

async function runEnrichment(adapter: DoorDashAdapter) {
  const BATCH_SIZE = 50;
  const toEnrich = await db.query(
    `SELECT id, doordash_id, canonical_name FROM restaurants
     WHERE doordash_id IS NOT NULL AND (address IS NULL OR address = '')
     LIMIT $1`,
    [BATCH_SIZE]
  );

  if (toEnrich.rows.length === 0) {
    console.log('[Discover-DD] No restaurants need enrichment.');
    return;
  }

  console.log(`[Discover-DD] Enriching ${toEnrich.rows.length} restaurants with real addresses...`);
  const browser = adapter.getBrowser();
  const storeQuery = loadQuery('storepageFeed.graphql');

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < toEnrich.rows.length; i++) {
    const rest = toEnrich.rows[i];
    const progress = `[${i + 1}/${toEnrich.rows.length}]`;

    try {
      const result = await browser.graphqlQuery<{
        data: {
          storepageFeed: {
            storeHeader: {
              address: {
                lat: number;
                lng: number;
                street: string;
                displayAddress: string;
                city: string;
                state: string;
              };
            };
          };
        };
      }>('storepageFeed', storeQuery, {
        storeId: rest.doordash_id,
        menuId: null,
        isMerchantPreview: false,
        fulfillmentType: 'Delivery',
        cursor: null,
        scheduledTime: null,
        entryPoint: 'HomePage',
      });

      const addr = result.data?.storepageFeed?.storeHeader?.address;
      if (addr?.displayAddress) {
        await db.query(
          `UPDATE restaurants SET address = $1, lat = $2, lng = $3 WHERE id = $4`,
          [addr.displayAddress, addr.lat, addr.lng, rest.id]
        );
        enriched++;
        console.log(`${progress} ${rest.canonical_name}: ${addr.displayAddress}`);
      } else {
        console.log(`${progress} ${rest.canonical_name}: no address in response`);
        failed++;
      }
    } catch (err) {
      console.error(`${progress} ${rest.canonical_name}: FAILED -`, err instanceof Error ? err.message : err);
      failed++;

      if (err instanceof Error && err.message.includes('429')) {
        console.log(`${progress} Rate limited — cooling down 30s...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }

    // Rate limit: 6s + jitter
    if (i < toEnrich.rows.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 6000 + Math.random() * 2000));
    }
  }

  console.log('\n=== Enrichment Complete ===');
  console.log(`Enriched: ${enriched}, Failed: ${failed}`);
  console.log(`Remaining without address: run again for next batch`);
}

async function main() {
  const isEnrich = process.argv.includes('--enrich');
  const email = process.env.DOORDASH_EMAIL;
  if (!email) {
    console.error('[Discover-DD] DOORDASH_EMAIL not set in .env');
    process.exit(1);
  }

  // Pre-launch Chrome HEADFUL on DoorDash CDP port.
  // DoorDash's Cloudflare blocks headless Chrome with 403.
  // The adapter's initialize() will find Chrome already running and connect via CDP.
  const CDP_PORT = 9224;
  const chromePath = findChromePath();
  const profileDir = getProfileDir('doordash');
  const args = getChromeArgs({ cdpPort: CDP_PORT, profileDir, headless: false });
  console.log('[Discover-DD] Launching Chrome headful for DoorDash...');
  const chromeProc = spawn(chromePath, args, { stdio: 'ignore', detached: false });
  chromeProc.on('exit', (code) => {
    console.warn(`[Discover-DD] Chrome launcher exited with code ${code}`);
  });
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Verify CDP is alive
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
    console.log('[Discover-DD] Chrome CDP alive on port', CDP_PORT);
  } catch (err) {
    console.error('[Discover-DD] Chrome failed to start. Is port 9224 already in use?');
    process.exit(1);
  }

  // Initialize adapter — its launch() will try to spawn headless Chrome on 9224,
  // but that fails silently because our headful Chrome already owns the port.
  // connectOverCDP then connects to our headful instance. This is the desired behavior.
  const adapter = new DoorDashAdapter();
  await adapter.initialize({ email });

  if (adapter.getStatus() !== 'authenticated') {
    console.error('[Discover-DD] Not authenticated. Log in via Settings page first.');
    process.exit(1);
  }

  if (isEnrich) {
    await runEnrichment(adapter);
  } else {
    await runGridSearch(adapter);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[Discover-DD] Fatal error:', err);
  process.exit(1);
});
