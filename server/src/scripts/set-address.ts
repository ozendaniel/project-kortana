/**
 * Set the Seamless delivery address via the home page UI.
 * Usage: cd server && npx tsx src/scripts/set-address.ts
 */
import { chromium } from 'playwright';

const CDP_PORT = 9223;
const ADDRESS = '330 7th Ave, New York, NY 10001';

async function main() {
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 15000 });
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();

  console.log('Loading seamless.com...');
  await page.goto('https://www.seamless.com', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // Find and click the address input
  console.log('Looking for address input...');
  const sel = 'input[aria-label*="address" i], input[placeholder*="address" i], input[name*="address" i]';

  try {
    await page.waitForSelector(sel, { timeout: 5000 });
  } catch {
    console.log('Address input not found. Current page text:');
    const text = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(text);
    await page.close();
    return;
  }

  // Triple-click to select all existing text
  await page.click(sel, { clickCount: 3 });
  await new Promise(r => setTimeout(r, 500));

  // Type the address using keyboard (survives React re-renders)
  console.log(`Typing: ${ADDRESS}`);
  await page.keyboard.type(ADDRESS, { delay: 40 });
  console.log('Waiting for autocomplete...');
  await new Promise(r => setTimeout(r, 3000));

  // Select first suggestion
  await page.keyboard.press('ArrowDown');
  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.press('Enter');
  console.log('Selected autocomplete suggestion. Waiting for navigation...');

  // Wait for the page to settle after address change
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 4000));

  // Verify
  const url = page.url();
  console.log('Current URL:', url);

  // Check if address is now set
  const addrCheck = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      if (input.value && input.value.includes('330')) return input.value;
    }
    // Also check nav text
    const nav = document.body.innerText.substring(0, 200);
    return nav.includes('330') ? 'Found "330" in page' : 'Address not visible';
  });
  console.log('Address check:', addrCheck);

  // Now test: navigate to Dim Sum Palace and check if categories have items
  console.log('\nTesting on Dim Sum Palace...');
  await page.goto('https://www.seamless.com/menu/dim-sum-palace-33-w-33rd-st-new-york/1387494', {
    waitUntil: 'networkidle', timeout: 45000,
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  const menuCheck = await page.evaluate(() => ({
    url: window.location.href,
    menuItems: document.querySelectorAll('.menuItem').length,
    bodyLen: document.body.innerText.length,
    hasBbqPork: document.body.innerText.includes('Bbq Pork') || document.documentElement.innerHTML.includes('Bbq Pork'),
    hasChickenFeet: document.body.innerText.includes('Chicken Feet') || document.documentElement.innerHTML.includes('Chicken Feet'),
    bodySnippet: document.body.innerText.substring(0, 300).replace(/\n+/g, ' | '),
  }));
  console.log('Menu check:', JSON.stringify(menuCheck, null, 2));

  await page.close();
  console.log('Done.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
