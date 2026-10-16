'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { hashPassword, verifyPassword, STAFF_USERS_SQL } = require('./auth');

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
}

// On first start, STAFF_USER and STAFF_PASSWORD create the first staff login.
// After that the staff_users table is the source of truth; changing the variables does nothing.
async function seedFirstUser() {
  const existing = await pool.query('SELECT 1 FROM staff_users LIMIT 1');
  if (existing.rows.length) return;
  const password = process.env.STAFF_PASSWORD || '';
  if (!password) return;
  const username = (process.env.STAFF_USER || 'staff').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(username) || password.length < 8) {
    console.warn('STAFF_USER or STAFF_PASSWORD is not valid (password needs 8+ characters). First login not created.');
    return;
  }
  await pool.query('INSERT INTO staff_users (username, password_hash) VALUES ($1, $2)', [username, await hashPassword(password)]);
  console.log(`Created first staff login "${username}".`);
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
// App
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/health', (req, res) => res.json({ ok: true }));

// Staff login: usernames and hashed passwords live in the staff_users table.
const AUTH_CACHE_MS = 60 * 1000;      // a verified login is trusted for a minute, so polling stays cheap
const LOCKOUT_FAILS = 10;             // wrong logins allowed per address...
const LOCKOUT_MS = 10 * 60 * 1000;    // ...within this window
const authCache = new Map();          // sha256(Authorization header) -> expiry time
const failures = new Map();           // ip -> { count, until }
let hasUsers = false;
let dummyHash = null;

async function anyUsers() {
  if (hasUsers) return true;
  const { rows } = await pool.query('SELECT 1 FROM staff_users LIMIT 1');
  hasUsers = rows.length > 0;
  return hasUsers;
}

async function staffAuth(req, res, next) {
  if (!(await anyUsers())) {
    return res.status(503).type('text').send(
      'No staff logins exist yet. In Railway, set STAFF_USER and STAFF_PASSWORD (8+ characters) on this service and redeploy, ' +
      'or run: node scripts/add-user.js <username> <password>'
    );
  }

  const now = Date.now();
  const rec = failures.get(req.ip);
  if (rec && rec.until > now && rec.count >= LOCKOUT_FAILS) {
    return res.status(429).type('text').send('Too many wrong logins. Try again in a few minutes.');
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const cacheKey = crypto.createHash('sha256').update(header).digest('hex');
    if ((authCache.get(cacheKey) || 0) > now) return next();

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const username = (i >= 0 ? decoded.slice(0, i) : decoded).trim().toLowerCase();
    const password = i >= 0 ? decoded.slice(i + 1) : '';

    if (username && password && username.length <= 100 && password.length <= 200) {
      const { rows } = await pool.query('SELECT password_hash FROM staff_users WHERE username = $1', [username]);
      if (!rows.length && !dummyHash) dummyHash = await hashPassword('not-a-real-password');
      const ok = await verifyPassword(password, rows.length ? rows[0].password_hash : dummyHash);
      if (ok && rows.length) {
        if (authCache.size > 500) authCache.clear();
        authCache.set(cacheKey, now + AUTH_CACHE_MS);
        failures.delete(req.ip);
        return next();
      }
    }

    if (!rec || rec.until <= now) failures.set(req.ip, { count: 1, until: now + LOCKOUT_MS });
    else rec.count += 1;
  }

  res.set('WWW-Authenticate', 'Basic realm="Pizza Order Book", charset="UTF-8"');
  return res.status(401).type('text').send('Staff login required.');
}

app.use((req, res, next) => staffAuth(req, res, next).catch(next));

app.use(express.json({ limit: '10kb' }));

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/api/orders', wrap(async (req, res) => {
  const cutoff = new Date(Date.now() - COMPLETED_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE status = 'open' OR completed_at >= $1
     ORDER BY pickup_date, pickup_time, id`,
    [cutoff]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ orders: rows.map(toOrder), menu: MENU });
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

app.use(express.static(path.join(__dirname, 'public')));

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
      await seedFirstUser();
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
  app.listen(PORT, '0.0.0.0', () => console.log(`Pizza Order Book listening on port ${PORT}`));
}

start();
