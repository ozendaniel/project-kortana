/**
 * One-shot: Run cross-platform matching for Dim Sum Palace.
 * Usage: cd server && npx tsx src/scripts/match-dim-sum-palace.ts
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { matchMenuItems } from '../services/matching.js';
import { db } from '../db/client.js';

const DB_ID = 'c953fe53-41a9-434b-9090-5d1d546495a9';

async function main() {
  // Show current state
  const counts = await db.query(
    'SELECT platform, COUNT(*) as cnt FROM menu_items WHERE restaurant_id = $1 GROUP BY platform',
    [DB_ID],
  );
  console.log('Menu items:');
  for (const r of counts.rows) console.log(`  ${r.platform}: ${r.cnt}`);

  // Run matching
  console.log('\nRunning 4-tier matching...');
  const result = await matchMenuItems(DB_ID);
  console.log('\nResult:');
  console.log(`  Matched: ${result.matched}`);
  console.log(`  Unmatched: ${result.unmatched}`);
  if ('matchRate' in result) console.log(`  Match rate: ${((result as any).matchRate * 100).toFixed(1)}%`);
  if ('shouldRefetch' in result) console.log(`  Should refetch: ${(result as any).shouldRefetch}`);

  // Show some matched pairs
  const matches = await db.query(`
    SELECT d.original_name as dd_name, d.price_cents as dd_price,
           s.original_name as sl_name, s.price_cents as sl_price,
           d.category as dd_cat
    FROM menu_items d
    JOIN menu_items s ON d.matched_item_id = s.id
    WHERE d.restaurant_id = $1 AND d.platform = 'doordash' AND s.platform = 'seamless'
    ORDER BY d.category, d.original_name
    LIMIT 30
  `, [DB_ID]);

  console.log(`\nSample matches (${matches.rows.length}):`);
  for (const r of matches.rows) {
    const ddPrice = `$${(r.dd_price / 100).toFixed(2)}`;
    const slPrice = `$${(r.sl_price / 100).toFixed(2)}`;
    const diff = r.sl_price - r.dd_price;
    const marker = diff > 0 ? ` (SL +$${(diff/100).toFixed(2)})` : diff < 0 ? ` (DD +$${(-diff/100).toFixed(2)})` : ' (same)';
    console.log(`  [${r.dd_cat}] ${r.dd_name} ${ddPrice} ↔ ${r.sl_name} ${slPrice}${marker}`);
  }

  // Show unmatched DD items
  const unmatchedDD = await db.query(`
    SELECT original_name, price_cents, category
    FROM menu_items
    WHERE restaurant_id = $1 AND platform = 'doordash' AND matched_item_id IS NULL
    ORDER BY category, original_name
    LIMIT 20
  `, [DB_ID]);

  if (unmatchedDD.rows.length > 0) {
    console.log(`\nUnmatched DD items (${unmatchedDD.rows.length}):`);
    for (const r of unmatchedDD.rows) {
      console.log(`  [${r.category}] ${r.original_name} $${(r.price_cents / 100).toFixed(2)}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
