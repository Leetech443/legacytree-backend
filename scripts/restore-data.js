// Restores the family data from a backup made by reset-data.js (replaces whatever is there now).
//   npm run restore-data -- backups/<file>.json                          -> DRY RUN
//   npm run restore-data -- backups/<file>.json --confirm=<database name>
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import { getDatabaseUrl, needsSsl } from '../src/dbUrl.js';
import { applySchema } from '../src/migrate.js';
import { TABLES, counts, restore, parseArgs } from './dataset.js';

let opts;
try { opts = parseArgs(process.argv.slice(2), ['confirm']); } catch (e) { console.error(e.message); process.exit(1); }
const file = opts._[0], confirm = opts.confirm;
if (!file || !fs.existsSync(file)) { console.error('Give the backup file: npm run restore-data -- backups/<file>.json'); process.exit(1); }
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const url = getDatabaseUrl(), dbName = decodeURIComponent(new URL(url).pathname.slice(1));
const c = new pg.Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: false } : false });
await c.connect();
try {
  await applySchema(c);
  const now = await counts(c);
  console.log(`Backup of "${backup.meta.database}" made ${backup.meta.createdAt}\nRestoring into "${dbName}"\n`);
  for (const t of TABLES) console.log(`  ${t.padEnd(18)} now ${String(now[t]).padStart(5)}  ->  after restore ${String(backup.data[t]?.length ?? 0).padStart(5)}`);
  if (confirm !== undefined && confirm !== dbName) { console.error(`\nRefusing: --confirm must be exactly "${dbName}" (you typed "${confirm}"). Nothing was changed.`); process.exit(1); }
  if (confirm === undefined) {
    console.log(`\nDRY RUN: nothing changed. To restore (this REPLACES the current family data):\n  npm run restore-data -- ${file} --confirm=${dbName}`);
    process.exit(0);
  }
  await c.query('BEGIN'); await restore(c, backup.data); await c.query('COMMIT');
  console.log('\nRestored.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\nFailed, nothing was changed:', e.message); process.exit(1);
} finally { await c.end(); }
