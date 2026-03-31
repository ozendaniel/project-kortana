import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected error on idle client:', err);
    });
  }
  return pool;
}

export const db = {
  query: (text: string, params?: unknown[]) => getPool().query(text, params),
  get pool() { return getPool(); },
};
