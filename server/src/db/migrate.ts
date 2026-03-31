import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
import { db } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(): Promise<void> {
  // Create migrations tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const applied = await db.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  // Read and sort migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`[Migrate] Applying ${file}...`);

    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await db.query('COMMIT');
      count++;
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`[Migrate] Failed on ${file}:`, err);
      process.exit(1);
    }
  }

  console.log(`[Migrate] Done. Applied ${count} new migration(s).`);
  process.exit(0);
}

migrate();
