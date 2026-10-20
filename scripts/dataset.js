// Shared helpers for reset-data.js and restore-data.js.
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // keep DATE columns as plain 'YYYY-MM-DD' (no timezone shifting)

/** Family data, parents first. admins and decline_reasons are deliberately NOT listed: they are kept. */
export const TABLES = ['members', 'member_spouses', 'member_contacts', 'member_profiles', 'rsvps', 'rsvp_attendance', 'rsvp_followups', 'rsvp_declines'];
const SERIAL = { members: 'id', member_spouses: 'id', rsvps: 'id', rsvp_followups: 'id' };
const q = (name) => `"${name}"`;

export async function counts(c) {
  const out = {};
  for (const t of TABLES) out[t] = Number((await c.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
  return out;
}

export async function dump(c) {
  const data = {};
  for (const t of TABLES) data[t] = (await c.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
  return data;
}

export const wipeSql = `TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`;

/** Replaces the family data with `data` (as produced by dump). Run inside a transaction. */
export async function restore(c, data) {
  await c.query(wipeSql);
  const insert = async (table, rows, omit = []) => {
    for (const r of rows) {
      const cols = Object.keys(r).filter((k) => !omit.includes(k));
      await c.query(`INSERT INTO ${table} (${cols.map(q).join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map((k) => r[k]));
    }
  };
  // members <-> member_spouses reference each other, so the mother link is filled in after both exist
  await insert('members', data.members || [], ['parent_spouse_id']);
  await insert('member_spouses', data.member_spouses || []);
  for (const m of data.members || []) if (m.parent_spouse_id) await c.query('UPDATE members SET parent_spouse_id = $1 WHERE id = $2', [m.parent_spouse_id, m.id]);
  for (const t of TABLES.filter((x) => !['members', 'member_spouses'].includes(x))) await insert(t, data[t] || []);
  for (const [t, col] of Object.entries(SERIAL)) {   // new records must continue after the highest restored id
    await c.query(`SELECT setval(pg_get_serial_sequence('${t}','${col}'), COALESCE((SELECT MAX(${col}) FROM ${t}), 1), (SELECT MAX(${col}) FROM ${t}) IS NOT NULL)`);
  }
}

/** Strict argument parser: accepts "--name=value" and "--name value"; any unknown option is an error (never silently ignored). */
export function parseArgs(argv, valueFlags = [], boolFlags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, ...rest] = a.slice(2).split('=');
    if (valueFlags.includes(k)) {
      const v = rest.length ? rest.join('=') : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
      out[k] = v;
    } else if (boolFlags.includes(k)) out[k] = true;
    else throw new Error(`Unknown option --${k}. Nothing was changed.`);
  }
  return out;
}
