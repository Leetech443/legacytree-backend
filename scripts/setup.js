// npm run setup -> applies schema.sql and creates/updates the first admin
import 'dotenv/config';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
await client.connect();
await client.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
if (ADMIN_USER && ADMIN_PASSWORD) {
  if (ADMIN_PASSWORD.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  await client.query(
    `INSERT INTO admins (username, password_hash) VALUES ($1,$2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [ADMIN_USER, await bcrypt.hash(ADMIN_PASSWORD, 12)]);
  console.log(`Admin "${ADMIN_USER}" ready.`);
}
await client.end();
console.log('Schema applied.');
