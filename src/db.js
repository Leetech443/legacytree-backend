import 'dotenv/config';
import pg from 'pg';
import { getDatabaseUrl, needsSsl } from './dbUrl.js';

pg.types.setTypeParser(1082, (v) => v); // return DATE columns as plain 'YYYY-MM-DD' strings
const url = getDatabaseUrl();

export const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl(url) ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 20000, // fail clearly instead of hanging forever
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

// Neon suspends idle compute and drops its connections. Without this handler an "idle client"
// error would crash the whole process; with it, the pool simply opens a fresh connection next time.
pool.on('error', (err) => console.error('[db] idle connection dropped, a new one will be opened:', err.message));

/* ---- retry only errors that happen while ESTABLISHING a connection (nothing has been sent yet,
        so retrying can never run a query twice) ---- */
const CONNECT_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN']);
const isConnectError = (e) => CONNECT_CODES.has(e?.code) || /timeout exceeded when trying to connect/i.test(e?.message || '');
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isConnectError(e) || attempt >= RETRIES) throw e;
      const wait = 500 * 2 ** attempt; // 0.5s, 1s, 2s
      console.warn(`[db] could not connect (${e.code || e.message}); retry ${attempt + 1}/${RETRIES} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

const rawQuery = pool.query.bind(pool);
pool.query = (...args) => withRetry(() => rawQuery(...args));

/** Run fn inside a transaction; rolls back on any error. */
export async function tx(fn) {
  const c = await withRetry(() => pool.connect());
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
