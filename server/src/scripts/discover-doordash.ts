/**
 * Bulk discover DoorDash restaurants via 3-pass search strategy.
 *
 * Pass 1: Deep pagination of the default feed (up to 150 pages)
 * Pass 2: Cuisine vertical filtering (23 cuisine IDs, paginate each)
 * Pass 3: Text search queries (25 common terms, paginate each)
 *
 * Usage:
 *   npx tsx src/scripts/discover-doordash.ts              # Full 3-pass discovery
 *   npx tsx src/scripts/discover-doordash.ts --pass 1     # Just deep pagination
 *   npx tsx src/scripts/discover-doordash.ts --pass 2     # Just cuisine verticals
 *   npx tsx src/scripts/discover-doordash.ts --pass 3     # Just text search
 *   npx tsx src/scripts/discover-doordash.ts --resume     # Resume from checkpoint
 *   npx tsx src/scripts/discover-doordash.ts --enrich     # Fetch real addresses for all
 *   npx tsx src/scripts/discover-doordash.ts --enrich --limit 10  # Enrich first 10
 *
 * Must run with server stopped (uses CDP port 9224).
 * Requires headful Chrome (Cloudflare blocks headless with 403).
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
const CHECKPOINT_PATH = path.join(__dirname, '..', '..', 'data', 'dd-discovery-checkpoint.json');

// --- Config ---
const MAX_PAGES_PER_FEED = 150;       // Safety cap per pagination sequence
const PAGE_DELAY_MS = 6000;            // Base delay between pages
const PAGE_JITTER_MS = 3000;           // Random jitter added to delay
const PASS_COOLDOWN_MS = 30000;        // Cooldown between passes
const RATE_LIMIT_COOLDOWN_MS = 45000;  // Cooldown after a 429
const HARD_COOLDOWN_MS = 300000;       // 5 min pause after 3 consecutive 429s
const MAX_CONSECUTIVE_429 = 3;

// Cuisine vertical IDs extracted from DoorDash cursor
const CUISINE_VERTICAL_IDS = [
  103, 100332, 70, 110044, 3, 146, 174, 2, 37, 139,
  271, 136, 235, 110001, 239, 236, 4, 243, 241, 268,
  148, 110013, 100333,
];

// Common search terms for text search pass
const SEARCH_TERMS = [
  'pizza', 'chinese', 'thai', 'sushi', 'indian', 'mexican', 'burger',
  'italian', 'korean', 'japanese', 'ramen', 'salad', 'sandwich',
  'breakfast', 'dessert', 'halal', 'vegan', 'wings', 'seafood',
  'bbq', 'mediterranean', 'greek', 'vietnamese', 'caribbean', 'deli',
];

// --- Checkpoint ---
interface Checkpoint {
  pass: number;
  /** Index into the current pass's iteration (cuisine ID index or search term index) */
  subIndex: number;
  pageNum: number;
  cursor: string;
  seenIds: string[];
  stats: PassStats;
  timestamp: string;
}

interface PassStats {
  pass1: { inserted: number; updated: number; pages: number };
  pass2: { inserted: number; updated: number; pages: number; verticalsDone: number };
  pass3: { inserted: number; updated: number; pages: number; termsDone: number };
}

function emptyStats(): PassStats {
  return {
    pass1: { inserted: 0, updated: 0, pages: 0 },
    pass2: { inserted: 0, updated: 0, pages: 0, verticalsDone: 0 },
    pass3: { inserted: 0, updated: 0, pages: 0, termsDone: 0 },
  };
}

function saveCheckpoint(cp: Checkpoint): void {
  const dir = path.dirname(CHECKPOINT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function loadCheckpoint(): Checkpoint | null {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function clearCheckpoint(): void {
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
}

// --- Helpers ---
function loadQuery(filename: string): string {
  const raw = fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
  const lines = raw.split('\n');
  const queryStart = lines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
  return lines.slice(queryStart).join('\n');
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

      // Skip convenience/retail stores — out of scope for food delivery comparison.
      // These have URLs like /convenience/store/{id}/ (Wegmans, Target, Staples, DSW, etc.)
      // Their menus use a different response shape (carousels/menuBook instead of itemLists).
      if (platformUrl.includes('/convenience/store/')) continue;

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

/** Extract pagination cursor from DoorDash feed response */
function extractCursor(feedPage: any): string | null {
  try {
    const nextData = feedPage?.next?.data;
    if (!nextData) return null;
    const parsed = typeof nextData === 'string' ? JSON.parse(nextData) : nextData;
    return parsed?.cursor || null;
  } catch { return null; }
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function pageDelay(): Promise<void> {
  return delay(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);
}

// --- Core pagination loop ---
/**
 * Paginate a single feed configuration (default, cuisine-filtered, or text-search).
 * Returns the number of new + updated restaurants found.
 */
async function paginateFeed(
  browser: ReturnType<DoorDashAdapter['getBrowser']>,
  searchQuery: string,
  seenIds: Set<string>,
  options: {
    label: string;
    filterQuery?: string;
    cuisineFilterVerticalIds?: string;
    startCursor?: string;
    startPage?: number;
  }
): Promise<{ inserted: number; updated: number; pages: number; lastCursor: string }> {
  let cursor = options.startCursor || '';
  let pageNum = options.startPage || 0;
  let inserted = 0;
  let updated = 0;
  let consecutive429 = 0;
  let consecutiveNoNew = 0;
  const MAX_CONSECUTIVE_NO_NEW = 3; // Skip to next vertical/term after 3 pages with 0 new

  while (pageNum < MAX_PAGES_PER_FEED) {
    pageNum++;
    const progress = `${options.label} [Page ${pageNum}]`;

    try {
      const result = await browser.mainTabGraphqlQuery<any>('homePageFacetFeed', searchQuery, {
        cursor,
        filterQuery: options.filterQuery || '',
        displayHeader: false,
        isDebug: false,
        cuisineFilterVerticalIds: options.cuisineFilterVerticalIds || '',
      }, 1);

      consecutive429 = 0; // Reset on success

      const feed = result?.data?.homePageFacetFeed;
      if (!feed?.body) {
        console.log(`${progress} Empty feed body. Stopping.`);
        break;
      }

      const stores = parseStoresFromFeed(feed);
      let pageNew = 0;
      let pageUpdated = 0;

      for (const store of stores) {
        if (seenIds.has(store.platformId)) continue;
        seenIds.add(store.platformId);

        const action = await upsertRestaurant({
          ...store,
          address: '',
          lat: 40.748,
          lng: -73.997,
        });

        if (action === 'inserted') { pageNew++; inserted++; }
        else { pageUpdated++; updated++; }
      }

      console.log(
        `${progress} ${stores.length} stores, ${pageNew} new, ${pageUpdated} updated (${seenIds.size} unique total)`
      );

      // Stop if no stores at all on this page
      if (stores.length === 0) {
        console.log(`${progress} No stores returned. Feed exhausted.`);
        break;
      }

      // Early termination: skip to next vertical/term if no new results
      if (pageNew === 0) {
        consecutiveNoNew++;
        if (consecutiveNoNew >= MAX_CONSECUTIVE_NO_NEW) {
          console.log(`${progress} ${MAX_CONSECUTIVE_NO_NEW} consecutive pages with 0 new. Skipping.`);
          break;
        }
      } else {
        consecutiveNoNew = 0;
      }

      // Extract next page cursor
      const nextCursor = extractCursor(feed?.page);
      if (!nextCursor) {
        console.log(`${progress} No next cursor. Done.`);
        break;
      }
      cursor = nextCursor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('429')) {
        consecutive429++;
        if (consecutive429 >= MAX_CONSECUTIVE_429) {
          console.log(`${progress} ${consecutive429} consecutive 429s — hard cooldown ${HARD_COOLDOWN_MS / 1000}s...`);
          await delay(HARD_COOLDOWN_MS);
          consecutive429 = 0;
          continue; // Retry same page
        }
        console.log(`${progress} Rate limited (429 #${consecutive429}) — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s...`);
        await delay(RATE_LIMIT_COOLDOWN_MS);
        continue; // Retry same page
      }

      console.error(`${progress} FAILED -`, msg);
      break;
    }

    await pageDelay();
  }

  return { inserted, updated, pages: pageNum, lastCursor: cursor };
}

// --- Session health check ---
// Uses a lightweight GraphQL query instead of DOM inspection, because mainTabGraphqlQuery
// context losses corrupt the page state and cause checkSession() false positives.
async function checkSessionHealth(adapter: DoorDashAdapter): Promise<boolean> {
  const browser = adapter.getBrowser();
  try {
    const query = loadQuery('getAvailableAddresses.graphql');
    const result = await browser.graphqlQuery<any>('getAvailableAddresses', query, {}, 1);
    const addresses = result?.data?.getAvailableAddresses;
    if (Array.isArray(addresses) && addresses.length > 0) return true;
    console.error('[Discover-DD] Session check: no addresses returned — session may be expired.');
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('403') || msg.includes('401')) {
      console.error('[Discover-DD] Session expired. Log in via Settings page and re-run.');
      return false;
    }
    // Other errors (context loss, timeout) don't necessarily mean session is dead
    console.warn(`[Discover-DD] Session check inconclusive: ${msg.substring(0, 80)}. Continuing.`);
    return true;
  }
}

// --- Pass implementations ---

async function runPass1(
  adapter: DoorDashAdapter,
  seenIds: Set<string>,
  stats: PassStats,
  resumeCursor?: string,
  resumePage?: number,
): Promise<boolean> {
  console.log('\n========== Pass 1: Deep Pagination ==========');
  if (!await checkSessionHealth(adapter)) return false;

  const browser = adapter.getBrowser();
  const searchQuery = loadQuery('homePageFacetFeed.graphql');

  // Load DoorDash homepage for full SPA context
  const mainPage = browser.getPage();
  if (mainPage) {
    console.log('[Pass 1] Loading DoorDash homepage for context...');
    await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await delay(5000);
  }

  const result = await paginateFeed(browser, searchQuery, seenIds, {
    label: '[Pass 1]',
    startCursor: resumeCursor,
    startPage: resumePage,
  });

  stats.pass1.inserted += result.inserted;
  stats.pass1.updated += result.updated;
  stats.pass1.pages += result.pages;

  console.log(`[Pass 1] Done: ${result.pages} pages, ${result.inserted} new, ${result.updated} updated`);
  return true;
}

async function runPass2(
  adapter: DoorDashAdapter,
  seenIds: Set<string>,
  stats: PassStats,
  startVerticalIndex?: number,
): Promise<boolean> {
  console.log('\n========== Pass 2: Cuisine Vertical Filtering ==========');
  if (!await checkSessionHealth(adapter)) return false;

  const browser = adapter.getBrowser();
  const searchQuery = loadQuery('homePageFacetFeed.graphql');
  const startIdx = startVerticalIndex || 0;

  for (let i = startIdx; i < CUISINE_VERTICAL_IDS.length; i++) {
    const verticalId = CUISINE_VERTICAL_IDS[i];

    // Session check every 5 verticals
    if (i > startIdx && i % 5 === 0) {
      if (!await checkSessionHealth(adapter)) return false;
    }

    const beforeSize = seenIds.size;
    const result = await paginateFeed(browser, searchQuery, seenIds, {
      label: `[Pass 2] Vertical ${verticalId} (${i + 1}/${CUISINE_VERTICAL_IDS.length})`,
      cuisineFilterVerticalIds: String(verticalId),
    });

    stats.pass2.inserted += result.inserted;
    stats.pass2.updated += result.updated;
    stats.pass2.pages += result.pages;
    stats.pass2.verticalsDone = i + 1;

    const gained = seenIds.size - beforeSize;
    console.log(`[Pass 2] Vertical ${verticalId}: ${result.pages} pages, +${gained} new unique`);

    // Save checkpoint after each vertical
    saveCheckpoint({
      pass: 2,
      subIndex: i + 1,
      pageNum: 0,
      cursor: '',
      seenIds: Array.from(seenIds),
      stats,
      timestamp: new Date().toISOString(),
    });

    if (i < CUISINE_VERTICAL_IDS.length - 1) {
      await delay(PAGE_DELAY_MS); // Cooldown between verticals
    }
  }

  console.log(`[Pass 2] Done: ${stats.pass2.verticalsDone} verticals, ${stats.pass2.inserted} new, ${stats.pass2.pages} pages`);
  return true;
}

async function runPass3(
  adapter: DoorDashAdapter,
  seenIds: Set<string>,
  stats: PassStats,
  startTermIndex?: number,
): Promise<boolean> {
  console.log('\n========== Pass 3: Text Search ==========');
  if (!await checkSessionHealth(adapter)) return false;

  const browser = adapter.getBrowser();
  const searchQuery = loadQuery('homePageFacetFeed.graphql');
  const startIdx = startTermIndex || 0;

  for (let i = startIdx; i < SEARCH_TERMS.length; i++) {
    const term = SEARCH_TERMS[i];

    // Session check every 5 terms
    if (i > startIdx && i % 5 === 0) {
      if (!await checkSessionHealth(adapter)) return false;
    }

    const beforeSize = seenIds.size;
    const result = await paginateFeed(browser, searchQuery, seenIds, {
      label: `[Pass 3] "${term}" (${i + 1}/${SEARCH_TERMS.length})`,
      filterQuery: term,
    });

    stats.pass3.inserted += result.inserted;
    stats.pass3.updated += result.updated;
    stats.pass3.pages += result.pages;
    stats.pass3.termsDone = i + 1;

    const gained = seenIds.size - beforeSize;
    console.log(`[Pass 3] "${term}": ${result.pages} pages, +${gained} new unique`);

    // Save checkpoint after each term
    saveCheckpoint({
      pass: 3,
      subIndex: i + 1,
      pageNum: 0,
      cursor: '',
      seenIds: Array.from(seenIds),
      stats,
      timestamp: new Date().toISOString(),
    });

    if (i < SEARCH_TERMS.length - 1) {
      await delay(PAGE_DELAY_MS); // Cooldown between terms
    }
  }

  console.log(`[Pass 3] Done: ${stats.pass3.termsDone} terms, ${stats.pass3.inserted} new, ${stats.pass3.pages} pages`);
  return true;
}

// --- Enrichment ---
async function runEnrichment(adapter: DoorDashAdapter, enrichLimit?: number) {
  const toEnrich = await db.query(
    `SELECT id, doordash_id, canonical_name FROM restaurants
     WHERE doordash_id IS NOT NULL
       AND (address IS NULL OR address = '' OR (lat = 40.748 AND lng = -73.997))
     ${enrichLimit ? 'LIMIT $1' : ''}`,
    enrichLimit ? [enrichLimit] : []
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
      const result = await browser.mainTabGraphqlQuery<{
        data: {
          storepageFeed: {
            storeHeader: {
              address: {
                lat: string;
                lng: string;
                street: string;
                displayAddress: string;
                city: string;
                state: string;
              };
            };
            mxInfo?: {
              phoneno?: string;
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
      const phone = result.data?.storepageFeed?.mxInfo?.phoneno || null;
      if (addr?.displayAddress) {
        await db.query(
          `UPDATE restaurants SET address = $1, lat = $2, lng = $3, phone = COALESCE($4, phone) WHERE id = $5`,
          [addr.displayAddress, parseFloat(addr.lat as any), parseFloat(addr.lng as any), phone, rest.id]
        );
        enriched++;
        console.log(`${progress} ${rest.canonical_name}: ${addr.displayAddress}${phone ? ` (${phone})` : ''}`);
      } else {
        console.log(`${progress} ${rest.canonical_name}: no address in response`);
        failed++;
      }
    } catch (err) {
      console.error(`${progress} ${rest.canonical_name}: FAILED -`, err instanceof Error ? err.message : err);
      failed++;

      if (err instanceof Error && err.message.includes('429')) {
        console.log(`${progress} Rate limited — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s...`);
        await delay(RATE_LIMIT_COOLDOWN_MS);
      }
    }

    if (i < toEnrich.rows.length - 1) {
      await delay(6000 + Math.random() * 2000);
    }
  }

  console.log('\n=== Enrichment Complete ===');
  console.log(`Enriched: ${enriched}, Failed: ${failed}`);
  const remaining = toEnrich.rows.length - enriched;
  if (remaining > 0) {
    console.log(`Remaining without address: ${remaining} (run again to retry)`);
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const isEnrich = args.includes('--enrich');
  const isResume = args.includes('--resume');
  const isFresh = args.includes('--fresh');
  const passFlag = args.indexOf('--pass');
  const singlePass = passFlag !== -1 ? parseInt(args[passFlag + 1], 10) : null;

  const email = process.env.DOORDASH_EMAIL;
  if (!email) {
    console.error('[Discover-DD] DOORDASH_EMAIL not set in .env');
    process.exit(1);
  }

  // Launch Chrome headful
  const CDP_PORT = 9224;
  const chromePath = findChromePath();
  const profileDir = getProfileDir('doordash');
  const chromeArgs = getChromeArgs({ cdpPort: CDP_PORT, profileDir, headless: false });
  console.log('[Discover-DD] Launching Chrome headful for DoorDash...');
  const chromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
  chromeProc.on('exit', (code) => {
    console.warn(`[Discover-DD] Chrome launcher exited with code ${code}`);
  });
  await delay(3000);

  // Verify CDP is alive
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (!resp.ok) throw new Error(`CDP check failed: ${resp.status}`);
    console.log('[Discover-DD] Chrome CDP alive on port', CDP_PORT);
  } catch {
    console.error('[Discover-DD] Chrome failed to start. Is port 9224 already in use?');
    process.exit(1);
  }

  const adapter = new DoorDashAdapter();
  await adapter.initialize({ email });

  if (adapter.getStatus() !== 'authenticated') {
    console.error('[Discover-DD] Not authenticated. Log in via Settings page first.');
    process.exit(1);
  }

  if (isEnrich) {
    // mainTabGraphqlQuery needs DoorDash SPA context — load homepage first
    const mainPage = adapter.getBrowser().getPage();
    if (mainPage) {
      console.log('[Discover-DD] Loading DoorDash homepage for SPA context...');
      await mainPage.goto('https://www.doordash.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await delay(5000);
    }

    const limitIdx = args.indexOf('--limit');
    const enrichLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
    await runEnrichment(adapter, enrichLimit);
    process.exit(0);
  }

  // --- Discovery mode ---
  let seenIds = new Set<string>();
  let stats = emptyStats();
  let startPass = singlePass || 1;
  let resumeSubIndex: number | undefined;

  // Load checkpoint if resuming
  if (isResume && !isFresh) {
    const cp = loadCheckpoint();
    if (cp) {
      console.log(`[Discover-DD] Resuming from checkpoint: pass ${cp.pass}, subIndex ${cp.subIndex}, ${cp.seenIds.length} seen IDs (saved ${cp.timestamp})`);
      seenIds = new Set(cp.seenIds);
      stats = cp.stats;
      startPass = cp.pass;
      resumeSubIndex = cp.subIndex;
    } else {
      console.log('[Discover-DD] No checkpoint found. Starting fresh.');
    }
  } else if (isFresh) {
    clearCheckpoint();
  }

  // Pre-populate seenIds from DB to avoid re-inserting existing restaurants
  if (seenIds.size === 0) {
    const existing = await db.query('SELECT doordash_id FROM restaurants WHERE doordash_id IS NOT NULL');
    for (const row of existing.rows) {
      seenIds.add(row.doordash_id);
    }
    console.log(`[Discover-DD] Pre-loaded ${seenIds.size} existing DoorDash IDs from DB`);
  }

  const startTime = Date.now();

  // Run passes
  const passesToRun = singlePass ? [singlePass] : [1, 2, 3].filter(p => p >= startPass);

  for (const pass of passesToRun) {
    let ok = true;

    if (pass === 1) {
      ok = await runPass1(adapter, seenIds, stats);
    } else if (pass === 2) {
      ok = await runPass2(adapter, seenIds, stats, pass === startPass ? resumeSubIndex : undefined);
    } else if (pass === 3) {
      ok = await runPass3(adapter, seenIds, stats, pass === startPass ? resumeSubIndex : undefined);
    }

    if (!ok) {
      console.error(`[Discover-DD] Pass ${pass} failed (session expired?). Saving checkpoint.`);
      saveCheckpoint({
        pass,
        subIndex: 0,
        pageNum: 0,
        cursor: '',
        seenIds: Array.from(seenIds),
        stats,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    // Save checkpoint between passes
    saveCheckpoint({
      pass: pass + 1,
      subIndex: 0,
      pageNum: 0,
      cursor: '',
      seenIds: Array.from(seenIds),
      stats,
      timestamp: new Date().toISOString(),
    });

    if (pass < 3 && !singlePass) {
      console.log(`\n--- Cooldown between passes (${PASS_COOLDOWN_MS / 1000}s) ---`);
      await delay(PASS_COOLDOWN_MS);
    }
  }

  // Final stats
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const dbCount = await db.query('SELECT COUNT(*) FROM restaurants WHERE doordash_id IS NOT NULL');

  console.log('\n============================');
  console.log('=== Discovery Complete ===');
  console.log('============================');
  console.log(`Time elapsed: ${elapsed} min`);
  console.log(`Unique restaurants found this run: ${seenIds.size}`);
  console.log(`Pass 1 (pagination): ${stats.pass1.pages} pages, ${stats.pass1.inserted} new`);
  console.log(`Pass 2 (cuisines):   ${stats.pass2.pages} pages, ${stats.pass2.inserted} new (${stats.pass2.verticalsDone}/${CUISINE_VERTICAL_IDS.length} verticals)`);
  console.log(`Pass 3 (text search): ${stats.pass3.pages} pages, ${stats.pass3.inserted} new (${stats.pass3.termsDone}/${SEARCH_TERMS.length} terms)`);
  console.log(`Total new inserted: ${stats.pass1.inserted + stats.pass2.inserted + stats.pass3.inserted}`);
  console.log(`Total DoorDash restaurants in DB: ${dbCount.rows[0].count}`);

  clearCheckpoint();
  process.exit(0);
}

main().catch(err => {
  console.error('[Discover-DD] Fatal error:', err);
  process.exit(1);
});
