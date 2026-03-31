/**
 * DoorDash GraphQL Query Capture Script
 *
 * Launches a headed browser, intercepts all GraphQL requests,
 * and saves the queries to server/src/adapters/doordash/queries/
 *
 * Usage: npx tsx src/scripts/capture-doordash.ts
 *
 * Steps:
 * 1. Browser opens to doordash.com
 * 2. Log in manually (email + OTP)
 * 3. Set your delivery address
 * 4. Search/browse restaurants
 * 5. Click into a restaurant to view menu
 * 6. Press Ctrl+C when done — captured queries are saved automatically
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '..', 'adapters', 'doordash', 'queries');
const PROFILE_DIR = path.join(os.homedir(), '.kortana', 'doordash-profile');
const CAPTURE_LOG = path.resolve(__dirname, '..', '..', 'captured-queries.json');

// Ensure directories exist
fs.mkdirSync(QUERIES_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

interface CapturedQuery {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  timestamp: string;
  url: string;
  responseStatus?: number;
  responseSnippet?: string;
}

const captured: CapturedQuery[] = [];
const seenOperations = new Set<string>();

async function main() {
  console.log('=== DoorDash GraphQL Capture Tool ===\n');
  console.log('Launching browser...\n');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || await context.newPage();

  // Intercept all requests to capture GraphQL queries
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/graphql')) return;

    try {
      const postData = request.postData();
      if (!postData) return;

      const body = JSON.parse(postData);
      const operationName = body.operationName || 'unknown';

      // Log every GraphQL call
      console.log(`[GraphQL] ${operationName}`);

      captured.push({
        operationName,
        query: body.query || '',
        variables: body.variables || {},
        timestamp: new Date().toISOString(),
        url,
      });

      // Save unique queries as .graphql files
      if (!seenOperations.has(operationName) && body.query) {
        seenOperations.add(operationName);
        const filename = `${operationName}.graphql`;
        const filepath = path.join(QUERIES_DIR, filename);

        const content = [
          `# DoorDash GraphQL: ${operationName}`,
          `# Captured: ${new Date().toISOString()}`,
          `# Variables: ${JSON.stringify(body.variables, null, 2)}`,
          '',
          body.query,
        ].join('\n');

        fs.writeFileSync(filepath, content, 'utf-8');
        console.log(`  -> Saved to queries/${filename}`);
      }
    } catch {
      // Not a JSON body, skip
    }
  });

  // Also capture responses for key operations
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/graphql')) return;

    try {
      const request = response.request();
      const postData = request.postData();
      if (!postData) return;

      const body = JSON.parse(postData);
      const operationName = body.operationName || 'unknown';

      // Save response snippets for key operations
      const keyOps = [
        'homePageFacetFeed', 'storepageFeed', 'addConsumerAddress',
        'convenienceSearchQuery', 'getConsumerProfile',
        'restaurantPage', 'getStore', 'getStoreMenu',
        'searchSuggestions', 'searchRestaurants',
      ];

      if (keyOps.some(op => operationName.toLowerCase().includes(op.toLowerCase()))) {
        const responseBody = await response.json().catch(() => null);
        if (responseBody) {
          const responseFile = path.join(QUERIES_DIR, `${operationName}.response.json`);
          fs.writeFileSync(responseFile, JSON.stringify(responseBody, null, 2), 'utf-8');
          console.log(`  -> Saved response to queries/${operationName}.response.json`);
        }
      }
    } catch {
      // Response parse error, skip
    }
  });

  // Navigate to DoorDash
  console.log('\nNavigating to DoorDash...');
  console.log('Please:\n');
  console.log('  1. LOG IN if needed (email + OTP)');
  console.log('  2. SET your delivery address');
  console.log('  3. SEARCH or browse restaurants');
  console.log('  4. CLICK into a restaurant to view its menu');
  console.log('  5. (Optional) Add an item to cart');
  console.log('\nAll GraphQL queries will be captured automatically.');
  console.log('When done, close the browser window or press Ctrl+C.\n');
  console.log('--- Capturing GraphQL queries ---\n');

  await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded' });

  // Keep the script running until the browser is closed
  await new Promise<void>((resolve) => {
    context.on('close', () => {
      resolve();
    });
    process.on('SIGINT', () => {
      console.log('\n\nShutting down...');
      resolve();
    });
  });

  // Save all captured queries to a single JSON log
  fs.writeFileSync(CAPTURE_LOG, JSON.stringify(captured, null, 2), 'utf-8');
  console.log(`\n=== Capture complete ===`);
  console.log(`Total GraphQL calls captured: ${captured.length}`);
  console.log(`Unique operations: ${seenOperations.size}`);
  console.log(`Operations: ${[...seenOperations].join(', ')}`);
  console.log(`\nQuery files saved to: ${QUERIES_DIR}`);
  console.log(`Full capture log: ${CAPTURE_LOG}`);

  await context.close().catch(() => {});
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
