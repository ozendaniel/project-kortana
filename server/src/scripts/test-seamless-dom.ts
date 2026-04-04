/**
 * Seamless DOM Scraping Test — with address management
 *
 * Sets delivery address near the restaurant, navigates to menu page,
 * scrolls incrementally to collect items from the virtualized DOM.
 *
 * Usage: cd server && npx tsx src/scripts/test-seamless-dom.ts [--restaurant-id ID] [--address "..."]
 */

import { chromium, type Page } from 'playwright';

const CDP_PORT = 9223;
const DEFAULT_RESTAURANT_ID = '12092888'; // Dim Sum Palace
const DEFAULT_ADDRESS = '24-28 Jackson Ave, Long Island City, NY'; // Near Dim Sum Palace

function hr(label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}\n`);
}

function parseArgs(): { restaurantId: string; address: string } {
  const args = process.argv.slice(2);
  let restaurantId = DEFAULT_RESTAURANT_ID;
  let address = DEFAULT_ADDRESS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restaurant-id' && args[i + 1]) restaurantId = args[i + 1];
    if (args[i] === '--address' && args[i + 1]) address = args[i + 1];
  }
  return { restaurantId, address };
}

async function setAddress(page: Page, address: string): Promise<boolean> {
  console.log(`Setting delivery address: ${address}`);

  // Navigate to seamless.com home and wait for full load
  await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // Use page.click with selector (auto-waits and re-queries) instead of element handles
  const sel = 'input[aria-label*="address" i], input[placeholder*="address" i]';
  try {
    await page.click(sel, { clickCount: 3, timeout: 5000 });
  } catch {
    console.log('  Address input not found/clickable');
    return false;
  }
  await new Promise(r => setTimeout(r, 500));

  // Type using page.keyboard (immune to React re-renders)
  await page.keyboard.type(address, { delay: 30 });
  console.log(`  Typed address, waiting for autocomplete...`);
  await new Promise(r => setTimeout(r, 2500));

  // ArrowDown + Enter to select first suggestion
  await page.keyboard.press('ArrowDown');
  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.press('Enter');

  // Wait for any navigation caused by address selection
  console.log(`  Selected autocomplete suggestion, waiting for navigation...`);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  console.log(`  Address set. URL: ${page.url()}`);
  return true;
}

async function main() {
  const { restaurantId, address } = parseArgs();
  hr('Seamless DOM Scraping Test');
  console.log(`Restaurant: ${restaurantId}`);
  console.log(`Address: ${address}`);

  // Connect
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] || await context.newPage();

  // Step 1: Set address (skip with --address skip)
  hr('Step 1: Set Delivery Address');
  if (address === 'skip') {
    console.log('Skipping address setting (using current saved address)');
  } else {
    await setAddress(page, address);
  }

  // Step 2: Navigate to restaurant
  hr('Step 2: Navigate to Restaurant');
  const targetUrl = `https://www.seamless.com/menu/${restaurantId}`;
  console.log(`Navigating to: ${targetUrl}`);

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`Navigation: ${e instanceof Error ? e.message.substring(0, 80) : e}`);
  }

  // Wait for SPA to render — the stencil/skeleton appears first, then real content
  console.log('Waiting for menu content to render (up to 20s)...');
  try {
    await page.waitForSelector('[class*="menuItem-name"], [class*="menuItemNew-name"], [class*="menuItem-price"]', { timeout: 20000 });
    console.log('Menu item selectors appeared!');
  } catch {
    console.log('No menu item selectors found within 20s — checking what we have...');
  }
  await new Promise(r => setTimeout(r, 2000));

  // Check if we're on the right restaurant (SPA may redirect if out of range)
  const pageUrl = page.url();
  console.log(`Current URL: ${pageUrl}`);
  const redirected = !pageUrl.includes(restaurantId);
  if (redirected) {
    console.log(`WARNING: Redirected away from restaurant ${restaurantId}!`);
    console.log('The delivery address may still be out of range.');

    // Check body text for clues
    const bodyClue = await page.evaluate(() =>
      document.body.innerText.includes("doesn't deliver") || document.body.innerText.includes('Out of range')
    );
    if (bodyClue) {
      console.log('Confirmed: restaurant is out of delivery range for this address.');
      console.log('Try a closer address with --address "..."');
      await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      return;
    }
  }

  // Step 3: Check page state
  hr('Step 3: Page State');
  const state = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    bodyLen: document.body.innerText.length,
    menuItems: document.querySelectorAll('[class*="menuItem"]').length,
    menuSections: document.querySelectorAll('[class*="menuSection"]').length,
    prices: Array.from(document.querySelectorAll('*')).filter(el =>
      /^\$\d+\.\d{2}$/.test(el.textContent?.trim() || '') && el.children.length === 0
    ).length,
    outOfRange: document.body.innerText.includes("doesn't deliver") || document.body.innerText.includes('Out of range'),
    restaurantName: document.querySelector('h1, [class*="restaurantName"], [data-testid*="restaurant-name"]')?.textContent?.trim() || '',
    bodyPreview: document.body.innerText.substring(0, 400).replace(/\n+/g, ' | '),
  }));
  console.log(`Title: ${state.title}`);
  console.log(`Restaurant name: ${state.restaurantName}`);
  console.log(`menuItem elements: ${state.menuItems}`);
  console.log(`menuSection elements: ${state.menuSections}`);
  console.log(`Price elements: ${state.prices}`);
  console.log(`Out of range: ${state.outOfRange}`);
  console.log(`Body: ${state.bodyPreview.substring(0, 300)}`);

  if (state.menuItems === 0) {
    console.log('\nNo menu items found. Checking DOM classes...');
    const classes = await page.evaluate(() => {
      const c: Record<string, number> = {};
      for (const el of document.querySelectorAll('*')) {
        if (typeof el.className !== 'string') continue;
        for (const cls of el.className.split(/\s+/)) {
          if (cls && /menu|item|price|section|category/i.test(cls)) {
            c[cls] = (c[cls] || 0) + 1;
          }
        }
      }
      return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 20));
    });
    for (const [cls, count] of Object.entries(classes)) {
      console.log(`  ${cls}: ${count}`);
    }
    await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    return;
  }

  // Step 4: Scroll and collect items incrementally
  hr('Step 4: Incremental Scroll Collection');

  // Scroll to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 1000));

  const collected = new Map<string, { name: string; price: string; category: string; id: string }>();

  const extractItems = () => page.evaluate(() => {
    const items: Array<{ key: string; name: string; price: string; category: string; id: string }> = [];

    const sections = document.querySelectorAll('[class*="menuSection"]');
    for (const section of sections) {
      const header = section.querySelector('h2, h3, [class*="menuSection-title"], [class*="header"]');
      const catName = header?.textContent?.trim() || '';
      if (!catName || catName.length > 80) continue;
      if (['Best Sellers', 'Order Again', 'Similar options nearby', 'Category Navigation', 'Search', 'Offers'].includes(catName)) continue;

      const itemEls = section.querySelectorAll('[class*="menuItem"]');
      for (const el of itemEls) {
        const nameEl = el.querySelector('[class*="menuItemNew-name"], [class*="menuItem-name"]');
        const name = nameEl?.textContent?.trim() || '';
        if (!name || name.length < 2) continue;

        const priceEl = el.querySelector('[class*="menuItem-price"]');
        const price = priceEl?.textContent?.trim() || '';
        if (!price.includes('$')) continue;

        const descEl = el.querySelector('[class*="menuItem-desc"]');
        const desc = descEl?.textContent?.trim() || '';

        // Get item ID
        let id = el.getAttribute('data-item-id') || el.getAttribute('data-testid') || '';
        if (!id) {
          const link = el.querySelector('a[href*="item/"]');
          const href = link?.getAttribute('href') || '';
          const m = href.match(/item\/(\d+)/);
          if (m) id = m[1];
        }
        if (!id) {
          id = `sl-${catName}-${name}`.replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 80);
        }

        const key = `${name}|${price}`;
        items.push({ key, name, price, category: catName, id });
      }
    }
    return items;
  });

  // Collect before scroll
  for (const item of await extractItems()) {
    if (!collected.has(item.key)) collected.set(item.key, item);
  }
  console.log(`Before scroll: ${collected.size} items`);

  // Scroll and collect
  let lastHeight = 0;
  let stableCount = 0;
  for (let i = 0; i < 100; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), (i + 1) * 400);
    await new Promise(r => setTimeout(r, 300));

    for (const item of await extractItems()) {
      if (!collected.has(item.key)) collected.set(item.key, item);
    }

    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) {
      stableCount++;
      if (stableCount >= 5) break;
    } else {
      stableCount = 0;
      lastHeight = height;
    }

    if (i % 10 === 0 && i > 0) console.log(`  scroll ${i}: ${collected.size} items collected`);
  }

  // Step 5: Report results
  hr('Step 5: Results');
  console.log(`Total items collected: ${collected.size}`);

  // Group by category
  const byCat = new Map<string, typeof collected extends Map<string, infer V> ? V[] : never>();
  for (const item of collected.values()) {
    if (!byCat.has(item.category)) byCat.set(item.category, []);
    byCat.get(item.category)!.push(item);
  }

  console.log(`Categories: ${byCat.size}`);
  for (const [cat, items] of byCat) {
    console.log(`\n  ${cat} (${items.length} items):`);
    for (const item of items.slice(0, 5)) {
      console.log(`    ${item.name} — ${item.price} [${item.id.substring(0, 30)}]`);
    }
    if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
  }

  // Summary
  hr('Summary');
  if (collected.size >= 50) {
    console.log(`SUCCESS: ${collected.size} items scraped from DOM.`);
    console.log('DOM scraping approach is viable. The incremental scroll collection works.');
    console.log('Next: integrate address management into the populate pipeline.');
  } else if (collected.size > 0) {
    console.log(`PARTIAL: Only ${collected.size} items. May need more scrolling or address adjustment.`);
  } else {
    console.log('FAIL: No items collected. Check page state above.');
  }

  // Navigate back
  await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
