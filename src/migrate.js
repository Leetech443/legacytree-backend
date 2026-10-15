// Applies db/schema.sql. The file is idempotent (safe to run any number of times) and never drops user data.
// The advisory lock stops two instances from migrating at the same moment.
import fs from 'node:fs';

const SQL = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export async function applySchema(client) {
  await client.query('SELECT pg_advisory_lock(727274)');
  try { await client.query(SQL); }
  finally { await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {}); }
}
