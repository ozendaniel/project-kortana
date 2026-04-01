/**
 * Run restaurant deduplication pipeline with stats and optional dry-run.
 *
 * Usage:
 *   npx tsx src/scripts/run-dedup.ts           # Run dedup and merge
 *   npx tsx src/scripts/run-dedup.ts --dry-run  # Preview matches without writing
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

import { db } from '../db/client.js';
import { deduplicateRestaurants } from '../services/deduplication.js';

async function getStats() {
  const [ddOnly, slOnly, matched, total] = await Promise.all([
    db.query('SELECT COUNT(*) FROM restaurants WHERE doordash_id IS NOT NULL AND seamless_id IS NULL'),
    db.query('SELECT COUNT(*) FROM restaurants WHERE seamless_id IS NOT NULL AND doordash_id IS NULL'),
    db.query('SELECT COUNT(*) FROM restaurants WHERE doordash_id IS NOT NULL AND seamless_id IS NOT NULL'),
    db.query('SELECT COUNT(*) FROM restaurants'),
  ]);

  return {
    ddOnly: parseInt(ddOnly.rows[0].count),
    slOnly: parseInt(slOnly.rows[0].count),
    matched: parseInt(matched.rows[0].count),
    total: parseInt(total.rows[0].count),
  };
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('=== Pre-Dedup Stats ===');
  const before = await getStats();
  console.log(`Total restaurants: ${before.total}`);
  console.log(`DoorDash only: ${before.ddOnly}`);
  console.log(`Seamless only: ${before.slOnly}`);
  console.log(`Already matched: ${before.matched}`);

  if (isDryRun) {
    console.log('\n--- DRY RUN MODE (no changes will be written) ---\n');
    const result = await deduplicateRestaurants({ dryRun: true });
    console.log(`\n--- Dry Run Results ---`);
    console.log(`Would merge: ${result.merged}`);
    console.log(`Would flag for review: ${result.flagged}`);
  } else {
    console.log('\nRunning deduplication...\n');
    const result = await deduplicateRestaurants();

    console.log('\n=== Post-Dedup Stats ===');
    const after = await getStats();
    console.log(`Total restaurants: ${after.total} (was ${before.total})`);
    console.log(`DoorDash only: ${after.ddOnly} (was ${before.ddOnly})`);
    console.log(`Seamless only: ${after.slOnly} (was ${before.slOnly})`);
    console.log(`Matched (both platforms): ${after.matched} (was ${before.matched})`);
    console.log(`\nMerged this run: ${result.merged}`);
    console.log(`Flagged for review: ${result.flagged}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[Dedup] Fatal error:', err);
  process.exit(1);
});
