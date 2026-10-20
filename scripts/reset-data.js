// Clears ALL family data (people, spouses, RSVPs, follow-ups) and keeps the admin accounts and reference lists.
//
//   npm run reset-data                                       -> DRY RUN: shows what would be deleted, deletes nothing
//   npm run reset-data -- --confirm=<database name>          -> saves a backup, then deletes
//   npm run reset-data -- --confirm=<db> --mothers "Mother One,Mother Two"   -> also creates the family mothers (1st, 2nd...)
//   (every option accepts --name=value or --name value; unknown options stop the script before anything is deleted)
//   add --no-backup to skip the backup file
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getDatabaseUrl, needsSsl } from '../src/dbUrl.js';
import { applySchema } from '../src/migrate.js';
import { TABLES, counts, dump, wipeSql, parseArgs } from './dataset.js';

let opts;
try {
  opts = parseArgs(process.argv.slice(2), ['confirm', 'mothers'], ['no-backup']);
  if (opts._.length) throw new Error(`Unexpected "${opts._[0]}". If a value has spaces, put it in quotes (for example --mothers "Mother One,Mother Two"). Nothing was changed.`);
} catch (e) { console.error(e.message); process.exit(1); }
const url = getDatabaseUrl(), u = new URL(url), dbName = decodeURIComponent(u.pathname.slice(1));
const c = new pg.Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: false } : false });
await c.connect();
try {
  await applySchema(c); // makes sure the tables and the reference lists (decline reasons) exist and are current
  const before = await counts(c);
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  const admins = (await c.query('SELECT count(*) FROM admins')).rows[0].count;
  const reasons = (await c.query('SELECT count(*) FROM decline_reasons')).rows[0].count;

  console.log(`Database: "${dbName}" on ${u.hostname}\n`);
  console.log('Family data currently in this database (a reset deletes all of it):');
  for (const t of TABLES) console.log(`  ${t.padEnd(18)} ${String(before[t]).padStart(6)} rows`);
  console.log(`\nKept as they are: admins (${admins}), decline_reasons (${reasons})\n`);

  const confirm = opts.confirm;
  if (!confirm) {
    console.log('DRY RUN: nothing was deleted.');
    console.log(`To delete for real, type the database name exactly:\n  npm run reset-data -- --confirm=${dbName}`);
    process.exit(0);
  }
  if (confirm !== dbName) { console.error(`Refusing: --confirm must be exactly "${dbName}" (you typed "${confirm}"). Nothing was deleted.`); process.exit(1); }

  if (!opts['no-backup'] && total > 0) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-${dbName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ meta: { database: dbName, createdAt: new Date().toISOString(), counts: before }, data: await dump(c) }));
    console.log(`Backup saved: ${file}  (${Math.round(fs.statSync(file).size / 1024)} KB)  contains personal data, keep it private`);
  }

  const mothers = (opts.mothers || '').split(',').map((s) => s.trim()).filter(Boolean);
  await c.query('BEGIN');
  await c.query(wipeSql);
  for (let i = 0; i < mothers.length; i++) {
    const { rows: [m] } = await c.query(`INSERT INTO members (full_name, generation, gender, has_children, birth_order) VALUES ($1,'PARENT','Female',true,$2) RETURNING id`, [mothers[i], i + 1]);
    await c.query('INSERT INTO member_contacts (member_id) VALUES ($1)', [m.id]);
  }
  await c.query('COMMIT');

  const after = await counts(c);
  console.log('\nDone. Family data now:');
  for (const t of TABLES) console.log(`  ${t.padEnd(18)} ${String(after[t]).padStart(6)} rows`);
  if (mothers.length) console.log(`\nFamily mothers created: ${mothers.map((m, i) => `${i + 1}. ${m}`).join('  |  ')}`);
  else console.log('\nNo mothers yet: add them in the admin portal (Family mothers) before anyone can register.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\nFailed, nothing was changed:', e.message);
  process.exit(1);
} finally { await c.end(); }
