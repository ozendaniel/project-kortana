/**
 * One-shot audit: how many matched restaurants have an "incomplete" Seamless menu?
 * Also looks up "10 Ave Finest Deli" specifically to compare SL vs DD counts.
 *
 * Usage: cd server && npx tsx src/scripts/audit-seamless-completeness.ts
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';

async function main() {
  const t0 = Date.now();
  console.log('=== Seamless menu completeness audit ===');
  console.log('Querying...');

  const audit = await db.query(`
    WITH c AS (
      SELECT r.id,
        COUNT(*) FILTER (WHERE mi.platform = 'seamless') AS sl,
        COUNT(*) FILTER (WHERE mi.platform = 'doordash') AS dd
      FROM restaurants r
      LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
      WHERE r.seamless_id IS NOT NULL
        AND r.doordash_id IS NOT NULL
        AND (r.platform_status->>'seamless' IS NULL OR r.platform_status->>'seamless' != 'delisted')
      GROUP BY r.id
    )
    SELECT
      COUNT(*) FILTER (WHERE dd > 5) AS baseline,
      COUNT(*) FILTER (WHERE dd > 5 AND sl < 0.30 * dd) AS r_30,
      COUNT(*) FILTER (WHERE dd > 5 AND sl < 0.50 * dd) AS r_50,
      COUNT(*) FILTER (WHERE dd > 5 AND sl < 0.70 * dd) AS r_70,
      COUNT(*) FILTER (WHERE dd > 5 AND sl < 0.85 * dd) AS r_85
    FROM c
  `);
  console.log(`(audit query: ${Date.now() - t0} ms)`);
  console.log(audit.rows[0]);

  console.log('\n=== "10 Ave Finest Deli" lookup ===');
  const ten = await db.query(`
    WITH c AS (
      SELECT r.id, r.canonical_name, r.seamless_id, r.doordash_id, r.last_synced_at, r.platform_status,
        COUNT(*) FILTER (WHERE mi.platform = 'seamless') AS sl,
        COUNT(*) FILTER (WHERE mi.platform = 'doordash') AS dd
      FROM restaurants r
      LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
      WHERE r.canonical_name ILIKE '%finest deli%'
         OR r.canonical_name ILIKE '%10 ave%'
         OR r.canonical_name ILIKE '%10th ave%'
         OR r.canonical_name ILIKE '%10ave%'
      GROUP BY r.id
    )
    SELECT * FROM c ORDER BY canonical_name LIMIT 15
  `);
  if (ten.rows.length === 0) {
    console.log('  (no matches found — try widening the ILIKE pattern)');
  }
  for (const row of ten.rows) {
    const ratio = row.dd > 0 ? (Number(row.sl) / Number(row.dd)).toFixed(2) : 'n/a';
    console.log(`  ${row.canonical_name}`);
    console.log(`    id=${row.id}`);
    console.log(`    SL=${row.sl}  DD=${row.dd}  ratio=${ratio}`);
    console.log(`    seamless_id=${row.seamless_id}  doordash_id=${row.doordash_id}`);
    console.log(`    last_synced_at=${row.last_synced_at}`);
    console.log(`    platform_status=${JSON.stringify(row.platform_status)}`);
  }

  console.log('\n=== Partial-data candidates (SL > 5, ratio < 0.50, DD > 20) — best smoke-test targets ===');
  const partial = await db.query(`
    WITH c AS (
      SELECT r.id, r.canonical_name, r.last_synced_at,
        COUNT(*) FILTER (WHERE mi.platform = 'seamless') AS sl,
        COUNT(*) FILTER (WHERE mi.platform = 'doordash') AS dd
      FROM restaurants r
      LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
      WHERE r.seamless_id IS NOT NULL
        AND r.doordash_id IS NOT NULL
        AND (r.platform_status->>'seamless' IS NULL OR r.platform_status->>'seamless' != 'delisted')
      GROUP BY r.id
    )
    SELECT * FROM c
    WHERE sl > 5 AND dd > 20 AND sl < 0.50 * dd
    ORDER BY (sl::float / NULLIF(dd, 0)) ASC, dd DESC
    LIMIT 10
  `);
  for (const row of partial.rows) {
    const ratio = row.dd > 0 ? (Number(row.sl) / Number(row.dd)).toFixed(2) : 'n/a';
    console.log(`  ${row.canonical_name.padEnd(45)} SL=${String(row.sl).padStart(4)}  DD=${String(row.dd).padStart(4)}  ratio=${ratio}  id=${row.id}`);
  }

  console.log('\n=== Worst offenders (ratio < 0.30, DD > 20 items) ===');
  const worst = await db.query(`
    WITH c AS (
      SELECT r.id, r.canonical_name, r.last_synced_at,
        COUNT(*) FILTER (WHERE mi.platform = 'seamless') AS sl,
        COUNT(*) FILTER (WHERE mi.platform = 'doordash') AS dd
      FROM restaurants r
      LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
      WHERE r.seamless_id IS NOT NULL
        AND r.doordash_id IS NOT NULL
        AND (r.platform_status->>'seamless' IS NULL OR r.platform_status->>'seamless' != 'delisted')
      GROUP BY r.id
    )
    SELECT * FROM c
    WHERE dd > 20 AND sl < 0.30 * dd
    ORDER BY (sl::float / NULLIF(dd, 0)) ASC, dd DESC
    LIMIT 15
  `);
  for (const row of worst.rows) {
    const ratio = row.dd > 0 ? (Number(row.sl) / Number(row.dd)).toFixed(2) : 'n/a';
    console.log(`  ${row.canonical_name.padEnd(45)} SL=${String(row.sl).padStart(4)}  DD=${String(row.dd).padStart(4)}  ratio=${ratio}  id=${row.id}`);
  }

  await db.pool.end();
}

main().catch((e) => {
  console.error('AUDIT FAILED:', e);
  process.exit(1);
});
