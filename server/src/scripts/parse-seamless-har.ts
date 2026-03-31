/**
 * Parse a Seamless/Grubhub HAR file and extract REST API endpoints and responses.
 * Usage: npx tsx src/scripts/parse-seamless-har.ts <path-to-har-file>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '..', 'adapters', 'seamless', 'endpoints');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const harPath = process.argv[2];
if (!harPath) {
  console.error('Usage: npx tsx src/scripts/parse-seamless-har.ts <path-to-har-file>');
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
const entries = har.log.entries as Array<{
  request: {
    url: string;
    method: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text: string };
    queryString: Array<{ name: string; value: string }>;
  };
  response: {
    status: number;
    content: { text?: string; mimeType?: string };
  };
  startedDateTime: string;
}>;

interface ExtractedEndpoint {
  name: string;
  method: string;
  url: string;
  path: string;
  queryParams: Record<string, string>;
  requestBody: unknown | null;
  responseStatus: number;
  response: unknown;
  headers: Record<string, string>;
  timestamp: string;
}

const extracted: ExtractedEndpoint[] = [];
const seenEndpoints = new Map<string, number>();

// Only capture api-gtm.grubhub.com calls (skip sensor, clickstream, etc.)
const SKIP_PATTERNS = [
  'sensor.grubhub.com',
  'clickstream/events',
  'consumer-engagement',
  'staticmap',
  'connect/google',
];

for (const entry of entries) {
  const { request, response } = entry;

  if (!request.url.includes('api-gtm.grubhub.com')) continue;
  if (SKIP_PATTERNS.some(p => request.url.includes(p))) continue;

  try {
    const urlObj = new URL(request.url);
    const pathStr = urlObj.pathname;

    // Normalize path: replace IDs with placeholders for grouping
    const normalizedPath = pathStr
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/{uuid}')
      .replace(/\/\d{5,}/g, '/{id}')
      .replace(/\/[A-Za-z0-9_-]{20,30}/g, '/{cartId}');

    const endpointKey = `${request.method} ${normalizedPath}`;
    const count = (seenEndpoints.get(endpointKey) || 0) + 1;
    seenEndpoints.set(endpointKey, count);

    // Parse query params
    const queryParams: Record<string, string> = {};
    urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });

    // Parse request body
    let requestBody: unknown = null;
    if (request.postData?.text) {
      try { requestBody = JSON.parse(request.postData.text); } catch { requestBody = request.postData.text; }
    }

    // Parse response
    let responseBody: unknown = null;
    if (response.content.text) {
      try { responseBody = JSON.parse(response.content.text); } catch { responseBody = null; }
    }

    // Extract relevant headers
    const relevantHeaders: Record<string, string> = {};
    for (const h of request.headers) {
      const name = h.name.toLowerCase();
      if (['authorization', 'perimeter-x', 'x-gh-features', 'content-type'].includes(name)) {
        relevantHeaders[name] = h.value;
      }
    }

    // Create a readable name from the path
    const nameParts = normalizedPath.split('/').filter(Boolean);
    const name = nameParts
      .filter(p => !p.startsWith('{'))
      .join('_')
      .replace(/-/g, '_');

    extracted.push({
      name: name || 'root',
      method: request.method,
      url: request.url,
      path: pathStr,
      queryParams,
      requestBody,
      responseStatus: response.status,
      response: responseBody,
      headers: relevantHeaders,
      timestamp: entry.startedDateTime,
    });
  } catch {
    // Skip malformed URLs
  }
}

console.log(`\n=== Seamless/Grubhub HAR Parse Results ===\n`);
console.log(`Total API requests found: ${extracted.length}`);
console.log(`Unique endpoints: ${seenEndpoints.size}\n`);

const sortedOps = [...seenEndpoints.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log('Endpoints captured:');
for (const [op, count] of sortedOps) {
  console.log(`  ${op} (${count}x)`);
}

// Save each unique endpoint
const savedEndpoints = new Set<string>();

// Group by endpoint key for saving
const groupedByKey = new Map<string, ExtractedEndpoint[]>();
for (const item of extracted) {
  const urlObj = new URL(item.url);
  const normalizedPath = urlObj.pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/{uuid}')
    .replace(/\/\d{5,}/g, '/{id}')
    .replace(/\/[A-Za-z0-9_-]{20,30}/g, '/{cartId}');
  const key = `${item.method} ${normalizedPath}`;
  if (!groupedByKey.has(key)) groupedByKey.set(key, []);
  groupedByKey.get(key)!.push(item);
}

// Save the best sample for each endpoint
for (const [key, items] of groupedByKey) {
  // Pick the item with the most data in the response
  const best = items.reduce((a, b) => {
    const aLen = JSON.stringify(a.response || '').length;
    const bLen = JSON.stringify(b.response || '').length;
    return bLen > aLen ? b : a;
  });

  const safeName = key
    .replace(/\s+/g, '_')
    .replace(/[{}\/]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();

  if (savedEndpoints.has(safeName)) continue;
  savedEndpoints.add(safeName);

  // Save endpoint description
  const desc = {
    endpoint: key,
    method: best.method,
    exampleUrl: best.url,
    queryParams: best.queryParams,
    requestBody: best.requestBody,
    responseStatus: best.responseStatus,
    headers: best.headers,
    capturedAt: best.timestamp,
    callCount: items.length,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${safeName}.endpoint.json`),
    JSON.stringify(desc, null, 2),
    'utf-8'
  );

  // Save response sample
  if (best.response) {
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${safeName}.response.json`),
      JSON.stringify(best.response, null, 2),
      'utf-8'
    );
  }
}

// Save manifest
const manifest = {
  platform: 'seamless',
  apiBase: 'https://api-gtm.grubhub.com',
  capturedAt: new Date().toISOString(),
  totalRequests: extracted.length,
  endpoints: sortedOps.map(([name, count]) => ({ name, count })),
  keyEndpoints: {
    search: 'GET /restaurants/search',
    restaurant: 'GET /restaurants/{id}',
    menuFeed: 'GET /restaurant_gateway/feed/{id}/{categoryId}',
    menuInfo: 'GET /restaurant_gateway/info/nonvolatile/{id}',
    menuItems: 'GET /restaurants/{id}/menu_items/',
    singleItem: 'GET /restaurants/{id}/menu_items/{itemId}',
    createCart: 'POST /carts',
    addToCart: 'POST /carts/{cartId}/lines',
    cartBill: 'GET /carts/{cartId}/bill',
    deliveryInfo: 'PUT /carts/{cartId}/delivery_info',
    fees: 'GET /restaurant_gateway/info/volatile/{id}',
  },
  authMechanism: {
    type: 'cookie + perimeter-x token',
    note: 'Auth via session cookies. perimeter-x header required for bot protection. No Bearer token — uses cookie-based sessions.',
  },
};

fs.writeFileSync(path.join(OUTPUT_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`\nFiles saved to: ${OUTPUT_DIR}`);
console.log(`  - ${savedEndpoints.size} .endpoint.json files`);
console.log(`  - ${savedEndpoints.size} .response.json files`);
console.log(`  - _manifest.json (summary)\n`);
