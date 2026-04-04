/**
 * One-shot: Scrape Dim Sum Palace (SL 1387494) with improved per-item category tracking.
 * Usage: cd server && npx tsx src/scripts/scrape-dim-sum-palace.ts
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import pg from 'pg';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

const DB_ID = 'c953fe53-41a9-434b-9090-5d1d546495a9';
const SL_ID = '1387494';
const CDP_PORT = 9223;
const SKIP_CATS = new Set([
  'Best Sellers', 'Most Ordered', 'Order Again', 'Similar options nearby',
  // Cookie consent / footer / non-menu h3 elements
  'Performance Cookies', 'Functional Cookies', 'Targeting Cookies', 'Strictly Necessary Cookies',
  'Schedule my order', 'Manage Consent Preferences', 'Your Privacy',
]);

async function main() {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 15000 });
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();

  console.log('Booting SPA...');
  await page.goto('https://www.seamless.com', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  console.log(`Navigating to Dim Sum Palace (SL ${SL_ID})...`);
  await page.goto(`https://www.seamless.com/menu/dim-sum-palace-33-w-33rd-st-new-york/${SL_ID}`, {
    waitUntil: 'networkidle', timeout: 45000,
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  console.log('URL:', page.url());
  const itemCount = await page.evaluate(() => document.querySelectorAll('.menuItem').length);
  console.log('Menu items in DOM:', itemCount);
  if (itemCount === 0) { console.log('FAIL'); await page.close(); process.exit(1); }

  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 1000));

  // Inject a MutationObserver via addScriptTag (avoids tsx __name decoration issue).
  // The observer captures EVERY .menuItem as it enters the DOM — no items missed between scroll steps.
  const skipJson = JSON.stringify([...SKIP_CATS]);
  await page.addScriptTag({
    content: `
    (function() {
      var skip = new Set(${skipJson});
      var captured = new Map();
      window.__capturedItems = captured;
      var priceRe = /([0-9]+\\.[0-9]{2})/;

      function processItem(el) {
        var nameEl = el.querySelector('.menuItemNew-name');
        var name = nameEl ? nameEl.textContent.trim() : '';
        if (!name || name.length < 2) return;
        var priceEl = el.querySelector('.menuItem-priceAmount') || el.querySelector('.menuItem-priceAmountUnbolded');
        var priceText = priceEl ? priceEl.textContent.trim() : '';
        var pm = priceText.match(priceRe);
        var priceCents = pm ? Math.round(parseFloat(pm[1]) * 100) : 0;
        var descEl = el.querySelector('.menuItem-description');
        var desc = descEl ? descEl.textContent.trim() : '';
        var tid = el.getAttribute('data-testid') || '';
        var idm = tid.match(/Item([0-9]+)/);
        var id = idm ? idm[1] : ('sl-auto-' + name).replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 80);
        // Find nearest h3 above this item
        var itemTop = el.getBoundingClientRect().top + window.scrollY;
        var menuScope = document.querySelector('[data-testid="menu-sections-container"]') || document;
        var cat = 'Menu';
        var allH = menuScope.querySelectorAll('h3, .menuSection-title');
        for (var i = 0; i < allH.length; i++) {
          var text = allH[i].textContent.trim();
          if (!text || text.length > 80 || skip.has(text)) continue;
          if (allH[i].closest('[class*="cookie"], [class*="consent"], [class*="footer"], [id*="onetrust"]')) continue;
          var hTop = allH[i].getBoundingClientRect().top + window.scrollY;
          if (hTop <= itemTop + 20) cat = text;
        }
        var key = name + '|' + priceCents;
        if (!captured.has(key)) captured.set(key, { name: name, priceCents: priceCents, desc: desc, cat: cat, id: id });
      }

      // Process existing items
      document.querySelectorAll('.menuItem').forEach(function(el) { processItem(el); });

      // Watch for new items
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          mutation.addedNodes.forEach(function(node) {
            if (node instanceof Element) {
              if (node.classList && node.classList.contains('menuItem')) processItem(node);
              node.querySelectorAll('.menuItem').forEach(function(child) { processItem(child); });
            }
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__capturedObserver = observer;
    })();
    `,
  });

  console.log('MutationObserver injected. Scrolling...');

  // Scroll through the entire page — the observer captures items automatically
  // At each step, also click any "View more items" buttons to expand collapsed categories
  let lastH = 0, stable = 0;
  for (let i = 0; i < 300; i++) {
    await page.evaluate((y: number) => window.scrollTo(0, y), (i + 1) * 250); // 250px steps
    await new Promise(r => setTimeout(r, 300));

    // Click any visible "View more items" buttons
    const clicked = await page.evaluate(() => {
      let count = 0;
      const buttons = document.querySelectorAll(
        '[data-testid*="restaurant-menu-section-footer"], button, div'
      );
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text === 'View more items' && btn instanceof HTMLElement) {
          btn.click();
          count++;
        }
      }
      return count;
    });
    if (clicked > 0) {
      console.log(`  Clicked ${clicked} "View more items" button(s) at scroll ${i}`);
      await new Promise(r => setTimeout(r, 2000)); // wait for items to load
    }

    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) { stable++; if (stable >= 8) break; } else { stable = 0; lastH = h; }
    if (i % 25 === 0 && i > 0) {
      const count = await page.evaluate(() => (window as any).__capturedItems.size);
      console.log('  scroll ' + i + ': ' + count + ' items captured, page height: ' + h);
    }
  }

  // Scroll back up to catch any items we might have missed
  console.log('Scrolling back up...');
  const maxH = await page.evaluate(() => document.body.scrollHeight);
  for (let y = maxH; y >= 0; y -= 400) {
    await page.evaluate((scrollY: number) => window.scrollTo(0, scrollY), y);
    await new Promise(r => setTimeout(r, 250));
  }
  await new Promise(r => setTimeout(r, 1000));

  // Read all captured items
  const collected = await page.evaluate(() => {
    const captured = (window as any).__capturedItems as Map<string, any>;
    (window as any).__capturedObserver?.disconnect();
    return [...captured.entries()].map(([key, val]) => ({ key, ...val }));
  });
  await page.close();

  console.log('\nScraped:', collected.length, 'items');

  // Group by category
  const catMap = new Map<string, Array<{ name: string; priceCents: number; desc: string; id: string }>>();
  for (const item of collected) {
    if (!catMap.has(item.cat)) catMap.set(item.cat, []);
    catMap.get(item.cat)!.push(item);
  }
  for (const [c, items] of [...catMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${c}: ${items.length}`);
  }

  // Upsert to DB
  console.log('\nUpserting to DB...');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const categories = [...catMap.entries()].map(([name, items]) => ({
    name,
    items: items.map(i => ({ platformItemId: i.id, name: i.name, priceCents: i.priceCents, description: i.desc })),
  }));

  const menuRes = await pool.query(
    `INSERT INTO menus (restaurant_id, platform, raw_data, fetched_at) VALUES ($1, 'seamless', $2, NOW())
     ON CONFLICT (restaurant_id, platform) DO UPDATE SET raw_data = $2, fetched_at = NOW() RETURNING id`,
    [DB_ID, JSON.stringify({ categories })],
  );
  const menuId = menuRes.rows[0].id;
  await pool.query('DELETE FROM menu_items WHERE menu_id = $1', [menuId]);

  let inserted = 0;
  for (const cat of categories) {
    for (const item of cat.items) {
      const cleanName = item.name.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
      await pool.query(
        `INSERT INTO menu_items (menu_id, restaurant_id, platform, canonical_name, original_name,
         description, price_cents, category, platform_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [menuId, DB_ID, 'seamless', cleanName, item.name, item.description || '', item.priceCents, cat.name, item.platformItemId],
      );
      inserted++;
    }
  }
  console.log('Inserted', inserted, 'SL items');
  await pool.query('UPDATE restaurants SET last_synced_at = NOW() WHERE id = $1', [DB_ID]);

  // Clear old matches and re-run matching
  console.log('\nClearing old matches...');
  await pool.query('UPDATE menu_items SET matched_item_id = NULL WHERE restaurant_id = $1', [DB_ID]);

  console.log('Running matching...');
  // Import and run matching
  const { matchMenuItems } = await import('../services/matching.js');
  const result = await matchMenuItems(DB_ID);
  console.log(`Matched: ${result.matched}, Unmatched: ${result.unmatched}`);
  if ('matchRate' in result) console.log(`Match rate: ${((result as any).matchRate * 100).toFixed(1)}%`);

  // Final state
  const counts = await pool.query(
    'SELECT platform, COUNT(*) as cnt FROM menu_items WHERE restaurant_id = $1 GROUP BY platform', [DB_ID],
  );
  console.log('\nFinal DB:');
  for (const r of counts.rows) console.log(`  ${r.platform}: ${r.cnt}`);

  await pool.end();
  console.log('Done!');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
