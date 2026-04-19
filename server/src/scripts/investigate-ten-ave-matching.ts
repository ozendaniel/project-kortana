/**
 * One-shot investigation: why is 10 Ave Finest Deli showing DD-only items in the UI
 * when SL has MORE items than DD in the DB?
 *
 * Hypothesis: cross-platform item matching is failing — there ARE SL items that
 * correspond to those DD items, but matched_item_id wasn't populated.
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';

const RESTAURANT_ID = '11d76620-63aa-41ab-a79d-50ade35aa5ef'; // 10 ave finest deli

async function main() {
  console.log('=== 10 Ave Finest Deli — matching investigation ===');
  console.log(`restaurant_id=${RESTAURANT_ID}\n`);

  // Match coverage on each side
  const coverage = await db.query(
    `
    SELECT
      platform,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE matched_item_id IS NOT NULL) AS matched,
      COUNT(*) FILTER (WHERE matched_item_id IS NULL) AS unmatched
    FROM menu_items
    WHERE restaurant_id = $1
    GROUP BY platform
    ORDER BY platform
  `,
    [RESTAURANT_ID]
  );
  console.log('Match coverage by platform:');
  for (const row of coverage.rows) {
    console.log(`  ${row.platform.padEnd(10)} total=${row.total}  matched=${row.matched}  unmatched=${row.unmatched}`);
  }

  // Sample 15 unmatched DD items
  console.log('\nUnmatched DoorDash items (sample of 15):');
  const ddUnmatched = await db.query(
    `
    SELECT id, canonical_name, original_name, price_cents, category, description
    FROM menu_items
    WHERE restaurant_id = $1 AND platform = 'doordash' AND matched_item_id IS NULL
    ORDER BY canonical_name
    LIMIT 15
  `,
    [RESTAURANT_ID]
  );
  for (const row of ddUnmatched.rows) {
    const desc = (row.description || '').slice(0, 60).replace(/\n/g, ' ');
    console.log(`  [DD] $${(row.price_cents / 100).toFixed(2).padStart(6)}  ${(row.canonical_name || '').padEnd(40)}  cat=${row.category || ''}`);
    if (desc) console.log(`         desc: ${desc}`);
  }

  // For 5 of those unmatched DD items, show 3 closest SL candidates by name similarity
  console.log('\n=== For each of 5 unmatched DD items, top 3 SL candidates by name (ILIKE) ===');
  const ddSample = ddUnmatched.rows.slice(0, 5);
  for (const dd of ddSample) {
    console.log(`\n  [DD UNMATCHED] $${(dd.price_cents / 100).toFixed(2)}  ${dd.canonical_name}`);
    // Use first 2-3 significant words for ILIKE
    const words = (dd.canonical_name || '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w: string) => w.length > 3);
    const probe = words.slice(0, 2).join('%');
    if (!probe) {
      console.log('    (no usable probe words)');
      continue;
    }
    const slMatches = await db.query(
      `
      SELECT canonical_name, original_name, price_cents, category, matched_item_id
      FROM menu_items
      WHERE restaurant_id = $1 AND platform = 'seamless'
        AND canonical_name ILIKE $2
      ORDER BY ABS(price_cents - $3) ASC
      LIMIT 3
    `,
      [RESTAURANT_ID, `%${probe}%`, dd.price_cents]
    );
    if (slMatches.rows.length === 0) {
      console.log(`    (no SL items contain "%${probe}%")`);
    }
    for (const sl of slMatches.rows) {
      const matchedFlag = sl.matched_item_id ? 'MATCHED-to-other-DD' : 'UNMATCHED';
      console.log(`    [SL] $${(sl.price_cents / 100).toFixed(2).padStart(6)}  ${sl.canonical_name.padEnd(40)}  cat=${sl.category || ''}  (${matchedFlag})`);
    }
  }

  // Sample of SL items — what categories are present? Possibly a category-mismatch issue
  console.log('\n=== Category distribution: DD vs SL ===');
  const cats = await db.query(
    `
    SELECT platform, category, COUNT(*) AS n
    FROM menu_items
    WHERE restaurant_id = $1 AND category IS NOT NULL
    GROUP BY platform, category
    ORDER BY platform, n DESC
  `,
    [RESTAURANT_ID]
  );
  let lastPlatform = '';
  for (const row of cats.rows) {
    if (row.platform !== lastPlatform) {
      console.log(`\n  ${row.platform}:`);
      lastPlatform = row.platform;
    }
    console.log(`    ${String(row.n).padStart(4)}  ${row.category}`);
  }

  await db.pool.end();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
