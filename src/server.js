import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, tx } from './db.js';
import { writeRsvp } from './rsvp.js';
import { registerSchema, rsvpSchema, parentSchema } from './validation.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) throw new Error('Set a strong JWT_SECRET');
const app = express();
app.set('trust proxy', 1); // behind Render's proxy
app.use(helmet());
const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!origins.length) console.warn('CORS_ORIGINS is empty: browsers on other domains (Netlify) will be blocked');
app.use(cors({ origin: origins, methods: ['GET', 'POST', 'PUT', 'DELETE'], maxAge: 86400 }));
app.use(express.json({ limit: '50kb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const validate = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    const e = new Error('Validation failed');
    e.status = 400;
    e.details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw e;
  }
  return r.data;
};
const requireAdmin = (req, res, next) => {
  try {
    req.admin = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
};

app.get('/', (_, res) => res.json({ service: 'legacytree-api' }));
app.get('/health', (_, res) => res.json({ ok: true, version: '1.4.0' }));

/* ---------- Public ---------- */
app.get('/api/options', wrap(async (_, res) => {
  const d = await pool.query('SELECT code,label FROM decline_reasons ORDER BY sort_order');
  res.json({ decline_reasons: d.rows });
}));

// Who can be chosen as a parent for a given generation (names only, no contact data)
const ELIGIBLE = {
  CHILD: `generation='PARENT'`,
  GRANDCHILD: `(generation='CHILD' AND has_children)`,
  GREAT_GRANDCHILD: `(generation='GRANDCHILD' AND has_children)`,
};
app.get('/api/parents', wrap(async (req, res) => {
  const cond = ELIGIBLE[req.query.for];
  if (!cond) return res.status(400).json({ error: 'Invalid "for"' });
  const g = ['Male', 'Female'].includes(req.query.gender) ? req.query.gender : null;
  const { rows } = await pool.query(
    `SELECT id, full_name, generation FROM members WHERE ${cond} AND ($1::text IS NULL OR gender=$1) ORDER BY full_name`, [g]);
  res.json(rows);
}));

const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30 });
app.post('/api/register', submitLimiter, wrap(async (req, res) => {
  const { member: m, rsvp } = validate(registerSchema, req.body);
  const out = await tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT id, generation, has_children FROM members WHERE id=$1', [m.parent_id]);
    const ok = p && (m.generation === 'CHILD' ? p.generation === 'PARENT'
      : m.generation === 'GRANDCHILD' ? p.generation === 'CHILD' && p.has_children
      : p.generation === 'GRANDCHILD' && p.has_children);
    if (!ok) { const e = new Error('Selected parent is not valid for this generation'); e.status = 400; throw e; }

    const { rows: [mem] } = await c.query(
      `INSERT INTO members (full_name, generation, gender, parent_id, lineage_side, has_children)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [m.full_name, m.generation, m.gender, m.parent_id, m.generation === 'CHILD' ? 'Maternal' : m.lineage_side || null, m.has_children]);
    await c.query(
      `INSERT INTO member_contacts (member_id,email,phone,age,guardian_name,guardian_phone) VALUES ($1,$2,$3,$4,$5,$6)`,
      [mem.id, m.email, m.phone, m.age ?? null, m.guardian_name, m.guardian_phone]);
    if (m.generation !== 'GREAT_GRANDCHILD') {
      await c.query('INSERT INTO member_profiles (member_id,occupation,marital_status,spouse_name) VALUES ($1,$2,$3,$4)',
        [mem.id, m.occupation, m.marital_status, m.marital_status === 'Married' ? m.spouse_name : null]);
    }
    return { member_id: mem.id, ...(await writeRsvp(c, mem.id, rsvp)) };
  });
  res.status(201).json({ member_id: out.member_id, manage_token: out.manage_token });
}));

// Member changes their answer later (e.g. MAYBE -> YES) using the token they received
app.put('/api/rsvp/:token', wrap(async (req, res) => {
  const rsvp = validate(rsvpSchema, req.body);
  const r = await tx(async (c) => {
    const { rows: [x] } = await c.query('SELECT member_id FROM rsvps WHERE manage_token=$1', [req.params.token]);
    if (!x) { const e = new Error('RSVP not found'); e.status = 404; throw e; }
    return writeRsvp(c, x.member_id, rsvp);
  });
  res.json({ ok: true, manage_token: r.manage_token });
}));

/* ---------- Family tree ---------- */
// Names of minors are sensitive, so the tree is admin-only unless TREE_PUBLIC=true.
const TREE_PUBLIC = process.env.TREE_PUBLIC === 'true';
const FAMILY_ROOT_NAME = process.env.FAMILY_ROOT_NAME || 'Mr. Pamba Patelo';
const isAdminReq = (req) => {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); return true; } catch { return false; }
};
app.get('/api/tree', wrap(async (req, res) => {
  const admin = isAdminReq(req);
  if (!admin && !TREE_PUBLIC) return res.status(401).json({ error: 'Sign in as an admin to view the family tree.' });
  const { rows } = await pool.query(
    `SELECT m.id, m.full_name AS name, m.generation, m.gender, m.parent_id, m.lineage_side, m.has_children, r.status, a.friends_count AS friends
     FROM members m LEFT JOIN rsvps r ON r.member_id = m.id LEFT JOIN rsvp_attendance a ON a.rsvp_id = r.id ORDER BY m.full_name`);
  // RSVP status is only shown to admins
  res.json({ root: FAMILY_ROOT_NAME, admin, members: rows.map((r) => ({ ...r, status: admin ? r.status : null, friends: admin ? r.friends : null })) });
}));

/* ---------- Admin ---------- */
app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), wrap(async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const { rows: [a] } = await pool.query('SELECT * FROM admins WHERE username=$1', [String(username)]);
  const ok = await bcrypt.compare(String(password), a?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!a || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: jwt.sign({ sub: a.id, u: a.username }, process.env.JWT_SECRET, { expiresIn: '8h' }) });
}));

const ROSTER_SQL = `
  SELECT m.id, m.full_name, m.generation, m.gender, m.lineage_side, m.has_children, m.created_at,
         p.full_name AS parent_name, c.email, c.phone, c.age, c.guardian_name, c.guardian_phone,
         pr.occupation, pr.marital_status, pr.spouse_name,
         r.status, r.updated_at, a.friends_count, a.arrival_date,
         f.remind_on AS followup_date, dr.label AS decline_reason, d.reason_text AS decline_text
  FROM members m
  LEFT JOIN members p ON p.id = m.parent_id
  LEFT JOIN member_contacts c ON c.member_id = m.id
  LEFT JOIN member_profiles pr ON pr.member_id = m.id
  LEFT JOIN rsvps r ON r.member_id = m.id
  LEFT JOIN rsvp_attendance a ON a.rsvp_id = r.id
  LEFT JOIN rsvp_followups f ON f.rsvp_id = r.id AND f.status = 'PENDING'
  LEFT JOIN rsvp_declines d ON d.rsvp_id = r.id
  LEFT JOIN decline_reasons dr ON dr.code = d.reason_code
  WHERE m.generation <> 'PARENT'`;

app.get('/api/admin/members', requireAdmin, wrap(async (_, res) => {
  const { rows } = await pool.query(`${ROSTER_SQL} ORDER BY m.created_at DESC LIMIT 5000`);
  res.json(rows);
}));

app.delete('/api/admin/members/:id', requireAdmin, wrap(async (req, res) => {
  try { await pool.query('DELETE FROM members WHERE id=$1', [req.params.id]); }
  catch (e) {
    if (e.code === '23503') { const err = new Error('Remove this person\'s registered descendants first.'); err.status = 409; throw err; }
    throw e;
  }
  res.json({ ok: true });
}));

app.get('/api/admin/overview', requireAdmin, wrap(async (_, res) => {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  const [by_generation, arrivals, friends_hosts, declines, recent, due] = await Promise.all([
    q(`SELECT m.generation, COALESCE(r.status::text,'NONE') AS status, count(*)::int AS n, COALESCE(sum(a.friends_count),0)::int AS friends
       FROM members m LEFT JOIN rsvps r ON r.member_id=m.id LEFT JOIN rsvp_attendance a ON a.rsvp_id=r.id
       WHERE m.generation<>'PARENT' GROUP BY 1,2`),
    // family = relatives who said yes; friends = family friends they are bringing
    q(`SELECT arrival_date AS date, count(*)::int AS family, COALESCE(sum(friends_count),0)::int AS friends FROM rsvp_attendance GROUP BY 1 ORDER BY 1`),
    q(`SELECT m.id, m.full_name, m.generation, p.full_name AS parent_name, a.friends_count AS friends, a.arrival_date
       FROM rsvp_attendance a JOIN rsvps r ON r.id=a.rsvp_id JOIN members m ON m.id=r.member_id LEFT JOIN members p ON p.id=m.parent_id
       WHERE a.friends_count > 0 ORDER BY a.friends_count DESC, m.full_name`),
    q(`SELECT dr.label, count(*)::int AS n FROM rsvp_declines d JOIN decline_reasons dr ON dr.code=d.reason_code GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT m.full_name, m.generation, r.status, r.updated_at FROM rsvps r JOIN members m ON m.id=r.member_id ORDER BY r.updated_at DESC LIMIT 8`),
    q(`SELECT count(*)::int AS n FROM rsvp_followups WHERE status='PENDING' AND remind_on<=CURRENT_DATE`),
  ]);
  res.json({ by_generation, arrivals, friends_hosts, declines, recent, followups_due: due[0].n });
}));

app.get('/api/admin/followups', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.remind_on, m.full_name, c.email, c.phone, (f.remind_on <= CURRENT_DATE) AS due
     FROM rsvp_followups f JOIN rsvps r ON r.id=f.rsvp_id JOIN members m ON m.id=r.member_id
     LEFT JOIN member_contacts c ON c.member_id=m.id
     WHERE f.status='PENDING' ORDER BY f.remind_on`);
  res.json(rows);
}));
app.post('/api/admin/followups/:id/done', requireAdmin, wrap(async (req, res) => {
  await pool.query(`UPDATE rsvp_followups SET status='DONE', done_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/admin/parents', requireAdmin, wrap(async (_, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.full_name, m.created_at, c.phone, c.email,
            (SELECT count(*) FROM members k WHERE k.parent_id = m.id)::int AS children_count
     FROM members m LEFT JOIN member_contacts c ON c.member_id = m.id
     WHERE m.generation = 'PARENT' ORDER BY m.full_name`);
  res.json(rows);
}));
app.post('/api/admin/parents', requireAdmin, wrap(async (req, res) => {
  const p = validate(parentSchema, req.body);
  const { rows: [m] } = await pool.query(
    `INSERT INTO members (full_name, generation, gender, has_children) VALUES ($1,'PARENT','Female',true) RETURNING id`, [p.full_name]);
  await pool.query('INSERT INTO member_contacts (member_id,email,phone) VALUES ($1,$2,$3)', [m.id, p.email, p.phone]);
  res.status(201).json({ id: m.id });
}));

const csvCell = (v) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};
app.get('/api/admin/export.csv', requireAdmin, wrap(async (_, res) => {
  const { rows } = await pool.query(`${ROSTER_SQL} ORDER BY m.generation, m.full_name`);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  res.type('text/csv').attachment('rsvps.csv')
    .send([cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\n'));
}));

/* ---------- Errors ---------- */
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'This person is already registered under that parent.' });
  if (err.code === '23503') return res.status(400).json({ error: 'Invalid reference value.' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message, details: err.details });
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`LegacyTree listening on ${port}`));
