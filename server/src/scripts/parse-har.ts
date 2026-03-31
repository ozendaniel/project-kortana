/**
 * Parse a HAR file and extract all DoorDash GraphQL queries and responses.
 * Usage: npx tsx src/scripts/parse-har.ts <path-to-har-file>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(__dirname, '..', 'adapters', 'doordash', 'queries');

fs.mkdirSync(QUERIES_DIR, { recursive: true });

const harPath = process.argv[2];
if (!harPath) {
  console.error('Usage: npx tsx src/scripts/parse-har.ts <path-to-har-file>');
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
const entries = har.log.entries as Array<{
  request: {
    url: string;
    method: string;
    postData?: { text: string };
  };
  response: {
    status: number;
    content: { text?: string; mimeType?: string };
  };
}>;

interface ExtractedQuery {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  responseStatus: number;
  response: unknown;
}

const extracted: ExtractedQuery[] = [];
const seenOperations = new Map<string, number>(); // operation -> count

for (const entry of entries) {
  const { request, response } = entry;

  // Only GraphQL requests
  if (!request.url.includes('/graphql') && !request.url.includes('graphql')) continue;
  if (request.method !== 'POST') continue;
  if (!request.postData?.text) continue;

  try {
    const body = JSON.parse(request.postData.text);
    const operationName = body.operationName || 'unknown';

    // Parse response
    let responseBody: unknown = null;
    if (response.content.text) {
      try {
        responseBody = JSON.parse(response.content.text);
      } catch {
        responseBody = response.content.text.substring(0, 500);
      }
    }

    const count = (seenOperations.get(operationName) || 0) + 1;
    seenOperations.set(operationName, count);

    extracted.push({
      operationName,
      query: body.query || '',
      variables: body.variables || {},
      responseStatus: response.status,
      response: responseBody,
    });
  } catch {
    // Not valid JSON, skip
  }
}

console.log(`\n=== DoorDash HAR Parse Results ===\n`);
console.log(`Total GraphQL requests found: ${extracted.length}`);
console.log(`Unique operations: ${seenOperations.size}\n`);

// Sort by operation name for clean output
const sortedOps = [...seenOperations.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log('Operations captured:');
for (const [op, count] of sortedOps) {
  console.log(`  ${op} (${count}x)`);
}

// Save each unique operation as a .graphql file + response sample
const savedOps = new Set<string>();

for (const item of extracted) {
  const { operationName, query, variables, response, responseStatus } = item;

  // Save the query (first occurrence of each operation)
  if (!savedOps.has(operationName) && query) {
    savedOps.add(operationName);

    // Save .graphql file
    const queryContent = [
      `# DoorDash GraphQL: ${operationName}`,
      `# Captured from HAR: ${new Date().toISOString()}`,
      `# Response status: ${responseStatus}`,
      `#`,
      `# Variables example:`,
      ...JSON.stringify(variables, null, 2).split('\n').map(l => `# ${l}`),
      '',
      query,
    ].join('\n');

    fs.writeFileSync(path.join(QUERIES_DIR, `${operationName}.graphql`), queryContent, 'utf-8');

    // Save response sample
    if (response) {
      fs.writeFileSync(
        path.join(QUERIES_DIR, `${operationName}.response.json`),
        JSON.stringify(response, null, 2),
        'utf-8'
      );
    }
  }
}

// Save a summary manifest
const manifest = {
  capturedAt: new Date().toISOString(),
  totalRequests: extracted.length,
  operations: sortedOps.map(([name, count]) => ({ name, count })),
};
fs.writeFileSync(path.join(QUERIES_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`\nFiles saved to: ${QUERIES_DIR}`);
console.log(`  - ${savedOps.size} .graphql query files`);
console.log(`  - ${savedOps.size} .response.json files`);
console.log(`  - _manifest.json (summary)\n`);
