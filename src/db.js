import 'dotenv/config';
import pg from 'pg';
import { getDatabaseUrl, needsSsl } from './dbUrl.js';

const url = getDatabaseUrl();

pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl(url) ? { rejectUnauthorized: false } : false,
  max: 10,
});

/** Run fn inside a transaction; rolls back on any error. */
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
