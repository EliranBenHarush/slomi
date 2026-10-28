const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';

// --- Database ---
function createPool() {
  if (process.env.USE_PG_MEM) {
    // In-memory Postgres for local testing only
    const { newDb } = require('pg-mem');
    const { Pool } = newDb().adapters.createPg();
    return new Pool();
  }
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  const isInternal = url.includes('.railway.internal') || url.includes('localhost');
  return new Pool({ connectionString: url, ssl: isInternal ? false : { rejectUnauthorized: false } });
}

const pool = createPool();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // amount > 0 = debt (product taken), amount < 0 = payment
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

// --- App ---
const app = express();
app.use(express.json());

// Simple password protection: cookie holds an HMAC of the password
const authToken = () => crypto.createHmac('sha256', APP_PASSWORD).update('debts-app').digest('hex');

function getCookie(req, name) {
  const match = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD || req.body.password === APP_PASSWORD) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth=${authToken()}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'סיסמה שגויה' });
});

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || getCookie(req, 'auth') === authToken()) return next();
  res.status(401).json({ error: 'נדרשת התחברות' });
});

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'שגיאת שרת' });
});

const toNum = v => Number(v);

app.get('/api/customers', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.phone,
           COALESCE(SUM(e.amount), 0) AS balance,
           COUNT(e.id) AS entries_count,
           MAX(e.created_at) AS last_activity
    FROM customers c
    LEFT JOIN entries e ON e.customer_id = c.id
    GROUP BY c.id, c.name, c.phone
    ORDER BY c.name`);
  res.json(rows.map(r => ({ ...r, balance: toNum(r.balance), entries_count: toNum(r.entries_count) })));
}));

app.post('/api/customers', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'חובה להזין שם' });
  const phone = (req.body.phone || '').trim() || null;
  const { rows } = await pool.query(
    'INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id, name, phone', [name, phone]);
  res.status(201).json(rows[0]);
}));

app.get('/api/customers/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await pool.query('SELECT id, name, phone FROM customers WHERE id = $1', [id]);
  if (!c.rows.length) return res.status(404).json({ error: 'לקוח לא נמצא' });
  const e = await pool.query(
    'SELECT id, description, amount, created_at FROM entries WHERE customer_id = $1 ORDER BY created_at DESC, id DESC', [id]);
  const entries = e.rows.map(r => ({ ...r, amount: toNum(r.amount) }));
  const balance = entries.reduce((s, r) => s + r.amount, 0);
  res.json({ ...c.rows[0], balance: Math.round(balance * 100) / 100, entries });
}));

app.put('/api/customers/:id', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'חובה להזין שם' });
  const phone = (req.body.phone || '').trim() || null;
  const { rowCount } = await pool.query(
    'UPDATE customers SET name = $1, phone = $2 WHERE id = $3', [name, phone, Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'לקוח לא נמצא' });
  res.json({ ok: true });
}));

app.delete('/api/customers/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM entries WHERE customer_id = $1', [id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [id]);
  res.json({ ok: true });
}));

app.post('/api/customers/:id/entries', wrap(async (req, res) => {
  const description = (req.body.description || '').trim();
  const amount = Number(req.body.amount);
  const type = req.body.type === 'payment' ? 'payment' : 'debt';
  if (!description) return res.status(400).json({ error: 'חובה להזין תיאור' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'סכום לא תקין' });
  const date = req.body.date ? new Date(req.body.date) : new Date();
  if (isNaN(date)) return res.status(400).json({ error: 'תאריך לא תקין' });
  const signed = type === 'payment' ? -amount : amount;
  const { rows } = await pool.query(
    'INSERT INTO entries (customer_id, description, amount, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [Number(req.params.id), description, signed, date.toISOString()]);
  res.status(201).json(rows[0]);
}));

app.delete('/api/entries/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM entries WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public')));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
