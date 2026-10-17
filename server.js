'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { hashPassword, verifyPassword, STAFF_USERS_SQL, SESSIONS_SQL } = require('./auth');

// ---------------------------------------------------------------------------
// Settings. Edit MENU to change the pizzas offered on the order form.
// ---------------------------------------------------------------------------
const MENU = [
  'Margherita',
  'Pepperoni',
  'Hawaiian',
  'BBQ Chicken',
  'Peri-Peri Chicken',
  'Four Cheese',
  'Vegetarian Supreme',
  'Meat Feast',
];

const PORT = process.env.PORT || 3000;
const COMPLETED_VISIBLE_DAYS = 7; // completed orders stay in the database; the screen shows the last 7 days

// A sign-in lasts this many hours (set SESSION_HOURS in Railway to change it; 1 to 72), or until the person signs out.
const SESSION_HOURS = Math.min(Math.max(Number(process.env.SESSION_HOURS) || 8, 1), 72);
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;
const COOKIE_NAME = 'pob_session';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database and set DATABASE_URL (see README.md).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      surname      TEXT NOT NULL,
      pizza        TEXT NOT NULL,
      pickup_date  TEXT NOT NULL,
      pickup_time  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, pickup_date, pickup_time)');
  await pool.query(STAFF_USERS_SQL);
  await pool.query(SESSIONS_SQL);
  await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [new Date()]);
}

// Logins named in the variables are created at startup if they do not exist yet:
//   STAFF_USER + STAFF_PASSWORD               one login
//   STAFF_LOGINS=anna:pass1234,ben:pass5678   any number of extra logins
// An existing login is never changed by the variables.
function loginsFromEnv() {
  const list = [];
  if (process.env.STAFF_PASSWORD) list.push([process.env.STAFF_USER || 'staff', process.env.STAFF_PASSWORD]);
  String(process.env.STAFF_LOGINS || '').split(',').forEach((raw) => {
    const entry = raw.trim();
    const i = entry.indexOf(':');
    if (i > 0) list.push([entry.slice(0, i), entry.slice(i + 1)]);
  });
  return list;
}

async function seedLogins() {
  for (const [rawUser, password] of loginsFromEnv()) {
    const username = rawUser.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(username) || password.length < 8) {
      console.warn(`Skipped login "${rawUser.trim()}": the username needs 2-40 letters, numbers, . _ - and the password needs 8+ characters.`);
      continue;
    }
    const existing = await pool.query('SELECT 1 FROM staff_users WHERE username = $1', [username]);
    if (existing.rows.length) continue;
    await pool.query('INSERT INTO staff_users (username, password_hash) VALUES ($1, $2)', [username, await hashPassword(password)]);
    await pool.query('DELETE FROM sessions WHERE username = $1', [username]); // a re-created login starts signed out everywhere
    console.log(`Created staff login "${username}".`);
  }
}

function toOrder(r) {
  return {
    id: r.id,
    name: r.name,
    surname: r.surname,
    pizza: r.pizza,
    date: r.pickup_date,
    time: r.pickup_time,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanOrder(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const surname = typeof b.surname === 'string' ? b.surname.trim() : '';
  const pizza = typeof b.pizza === 'string' ? b.pizza : '';
  const date = b.date;
  const time = b.time;

  if (!name || name.length > 40) return { error: 'Enter a name of up to 40 characters.' };
  if (!surname || surname.length > 40) return { error: 'Enter a surname of up to 40 characters.' };
  if (!MENU.includes(pizza)) return { error: 'Choose a pizza from the menu.' };
  if (!isRealDate(date)) return { error: 'Pick a valid collection date.' };
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Pick a valid collection time.' };
  return { value: { name, surname, pizza, date, time } };
}

function parseId(raw) {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Sessions. A signed-in browser holds a random token in a cookie. Only a hash of
// the token is stored in the sessions table, so a database leak cannot be replayed.
// ---------------------------------------------------------------------------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN_FORMAT = /^[a-f0-9]{64}$/;

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== COOKIE_NAME) continue;
    const value = part.slice(i + 1).trim();
    return TOKEN_FORMAT.test(value) ? value : '';
  }
  return '';
}

// No Max-Age or Expires: the cookie is dropped when the browser closes. The server also ends
// every session after SESSION_HOURS, whatever the browser does.
function cookieFlags(req, extra) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax'].concat(extra || []);
  if (req.secure) flags.push('Secure');
  return flags.join('; ');
}
function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieFlags(req)}`);
}
function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req, ['Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'])}`);
}

async function sessionUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.username FROM sessions s
     JOIN staff_users u ON u.username = s.username
     WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha(token), new Date()]
  );
  return rows.length ? rows[0].username : null;
}

// Wrong-password limits. Counted per address + username, so one person mistyping does not lock out
// the whole restaurant (everyone shares one Wi-Fi address), plus a looser limit per address.
const LOCKOUT_MS = 10 * 60 * 1000;
const LIMIT_PER_USER = 10;
const LIMIT_PER_IP = 50;
const attempts = new Map(); // key -> { count, until }
let dummyHash = null;

function isLocked(key, limit, now) {
  const r = attempts.get(key);
  return !!r && r.until > now && r.count >= limit;
}
function addFailure(key, now) {
  if (attempts.size > 2000) {
    for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
  }
  const r = attempts.get(key);
  if (!r || r.until <= now) attempts.set(key, { count: 1, until: now + LOCKOUT_MS });
  else r.count += 1;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(express.json({ limit: '10kb' }));

// Login page: open to everyone. Someone already signed in goes straight to the orders.
app.get('/login', wrap(async (req, res) => {
  if (await sessionUser(req)) return res.redirect(302, '/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'login.html'));
}));

app.post('/api/login', wrap(async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const now = Date.now();
  const ipKey = `ip:${req.ip}`;
  const userKey = `user:${req.ip}|${username.slice(0, 100)}`;

  res.set('Cache-Control', 'no-store');
  if (isLocked(ipKey, LIMIT_PER_IP, now) || isLocked(userKey, LIMIT_PER_USER, now)) {
    return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });
  }

  const anyUser = await pool.query('SELECT 1 FROM staff_users LIMIT 1');
  if (!anyUser.rows.length) {
    return res.status(503).json({ error: 'No staff logins exist yet. The owner needs to set STAFF_USER and STAFF_PASSWORD in Railway.' });
  }

  let ok = false;
  if (username && password && username.length <= 100 && password.length <= 200) {
    const { rows } = await pool.query('SELECT password_hash FROM staff_users WHERE username = $1', [username]);
    if (!rows.length && !dummyHash) dummyHash = await hashPassword('not-a-real-password');
    // Always hash-check, even for an unknown username, so the response time does not reveal which usernames exist.
    const match = await verifyPassword(password, rows.length ? rows[0].password_hash : dummyHash);
    ok = match && rows.length > 0;
  }

  if (!ok) {
    addFailure(ipKey, now);
    addFailure(userKey, now);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }

  attempts.delete(userKey);
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [new Date()]);
  await pool.query(
    'INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)',
    [sha(token), username, new Date(now + SESSION_MS)]
  );
  setSessionCookie(req, res, token);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = readToken(req);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  clearSessionCookie(req, res);
  res.status(204).end();
}));

// Everything below needs a signed-in session.
async function requireSession(req, res, next) {
  const user = await sessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required.' });
  if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, '/login');
  return res.status(401).type('text').send('Sign in required.');
}
app.use((req, res, next) => requireSession(req, res, next).catch(next));

app.get('/api/orders', wrap(async (req, res) => {
  const cutoff = new Date(Date.now() - COMPLETED_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE status = 'open' OR completed_at >= $1
     ORDER BY pickup_date, pickup_time, id`,
    [cutoff]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ orders: rows.map(toOrder), menu: MENU, user: req.user });
}));

app.post('/api/orders', wrap(async (req, res) => {
  const { value, error } = cleanOrder(req.body);
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO orders (name, surname, pizza, pickup_date, pickup_time)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [value.name, value.surname, value.pizza, value.date, value.time]
  );
  res.status(201).json({ order: toOrder(rows[0]) });
}));

app.patch('/api/orders/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const status = req.body && req.body.status;
  if (id === null) return res.status(400).json({ error: 'Invalid order id.' });
  if (status !== 'open' && status !== 'completed') {
    return res.status(400).json({ error: 'Status must be "open" or "completed".' });
  }
  const result = status === 'completed'
    ? await pool.query(
        `UPDATE orders SET status = 'completed', completed_at = $2 WHERE id = $1 RETURNING *`,
        [id, new Date()]
      )
    : await pool.query(
        `UPDATE orders SET status = 'open', completed_at = NULL WHERE id = $1 RETURNING *`,
        [id]
      );
  if (!result.rows.length) return res.status(404).json({ error: 'That order no longer exists.' });
  res.json({ order: toOrder(result.rows[0]) });
}));

app.delete('/api/orders/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid order id.' });
  await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  res.status(204).end();
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error. Try again in a moment.' });
});

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await initDb();
      await seedLogins();
      break;
    } catch (err) {
      if (attempt >= 8) {
        console.error('Could not set up the database:', err.message);
        process.exit(1);
      }
      console.warn(`Database not ready (attempt ${attempt}): ${err.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`Pizza Order Book listening on port ${PORT} (sign-ins last ${SESSION_HOURS} hours)`));
}

start();
