// npm run check-db -> shows which database the app will use (never prints the password) and tests the connection.
import 'dotenv/config';
import pg from 'pg';
import { getDatabaseUrl, needsSsl } from '../src/dbUrl.js';

try {
  const url = getDatabaseUrl();
  const u = new URL(url);
  console.log(`Host:      ${u.hostname}`);
  console.log(`Database:  ${u.pathname.slice(1)}`);
  console.log(`User:      ${decodeURIComponent(u.username)}`);
  console.log(`Password:  ${u.password ? 'set (' + u.password.length + ' chars)' : 'MISSING'}`);
  const c = new pg.Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: false } : false });
  await c.connect();
  const { rows: [r] } = await c.query(`SELECT current_database() AS db, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') AS tables`);
  console.log(`\nConnected OK to "${r.db}". Tables found: ${r.tables}${Number(r.tables) === 0 ? '  (empty: run `npm run setup`)' : ''}`);
  await c.end();
} catch (e) {
  console.error('\nCould not connect:', e.message);
  if (/ENOTFOUND/.test(e.message)) console.error('-> The host name is wrong. Copy ONLY the postgresql://... part from Neon (Connect > Connection string).');
  if (/password authentication/.test(e.message)) console.error('-> Wrong password. Reset it in Neon, and URL-encode special characters (@ -> %40, / -> %2F, # -> %23, ? -> %3F).');
  process.exit(1);
}
