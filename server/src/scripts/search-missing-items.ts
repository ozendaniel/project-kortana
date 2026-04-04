/**
 * Use Seamless's in-menu search endpoint to find items missing from the regular feed.
 * These items exist in Seamless's search index but aren't in the category feeds.
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

const CDP_PORT = 9223;
const SL_ID = '1387494';

// Search terms derived from DD items that didn't match any SL item
const SEARCH_TERMS = [
  'pork bun', 'chicken feet', 'chicken juicy', 'shanghai juicy',
  'crabmeat', 'fried buns', 'steamed spare ribs', 'cucumber',
  'coconut', 'bbq pork', 'condensed milk',
];

async function main() {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 15000 });
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('https://www.seamless.com', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // Get auth token
  const token = await page.evaluate(() => {
    const s = localStorage.getItem('grub-api:authenticatedSession');
    return s ? JSON.parse(s).sessionHandle?.accessToken : null;
  });

  if (!token) {
    console.log('No auth token. Need to be logged in.');
    await page.close();
    return;
  }

  console.log('Auth token found. Searching for missing items...\n');

  const allFound: Array<{ name: string; price: number; id: string; searchTerm: string }> = [];

  for (const term of SEARCH_TERMS) {
    const result = await page.evaluate(async (args: { restId: string; token: string; query: string }) => {
      const resp = await fetch(
        `https://api-gtm.grubhub.com/restaurant_gateway/info/item_search/volatile/${args.restId}?inMenuSearchQuery=${encodeURIComponent(args.query)}&platform=WEB`,
        { headers: { 'Authorization': `Bearer ${args.token}` } }
      );
      if (!resp.ok) return { error: resp.status };
      const data = await resp.json();
      const content = data?.object?.data?.content || [];
      return content
        .filter((c: any) => c.entity?.item_name)
        .map((c: any) => ({
          name: c.entity.item_name,
          id: c.entity.item_id || c.entity.uuid || '',
          price: c.entity.item_price?.delivery?.value || c.entity.item_price?.pickup?.value || 0,
        }));
    }, { restId: SL_ID, token, query: term });

    if (Array.isArray(result) && result.length > 0) {
      console.log(`"${term}" → ${result.length} results:`);
      for (const item of result) {
        console.log(`  ${item.name} — $${(item.price / 100).toFixed(2)} [${item.id}]`);
        allFound.push({ ...item, searchTerm: term });
      }
    } else {
      console.log(`"${term}" → no results`);
    }

    await new Promise(r => setTimeout(r, 1000)); // rate limit
  }

  console.log(`\nTotal found via search: ${allFound.length} items`);
  console.log('Unique:', new Set(allFound.map(i => i.id)).size);

  await page.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
