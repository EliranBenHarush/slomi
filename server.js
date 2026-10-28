const express = require('express');
const crypto = require('crypto');
const path = require('path');
const wa = require('./whatsapp');

// whatsapp-web.js can reject promises in its own event handlers; never let that take the app down
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));

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
  // Set when a debt entry is marked as paid; paid entries don't count toward the balance
  await pool.query('ALTER TABLE entries ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
}

const SETTING_KEYS = ['business_name', 'footer'];

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = Object.fromEntries(SETTING_KEYS.map(k => [k, '']));
  for (const r of rows) if (SETTING_KEYS.includes(r.key)) s[r.key] = r.value || '';
  return s;
}

// --- WhatsApp statement message (WhatsApp formatting: *bold*, _italic_) ---
const money = n => '₪' + Math.abs(n).toLocaleString('he-IL', { maximumFractionDigits: 2 });
const day = d => new Date(d).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: '2-digit' });

function buildStatement(customer, entries, settings) {
  const open = entries.filter(e => e.amount > 0 && !e.paid_at).reverse();
  const payments = entries.filter(e => e.amount < 0).reverse();
  const balance = open.reduce((s, e) => s + e.amount, 0) + payments.reduce((s, e) => s + e.amount, 0);
  const line = '━━━━━━━━━━━━━━';

  const out = [];
  if (settings.business_name) out.push(`🏪 *${settings.business_name}*`, '');
  out.push(`*שלום ${customer.name}* 👋`, 'מצורף פירוט החשבון שלך:');
  out.push('', `🧾 *פירוט חובות*`, line);
  if (open.length) open.forEach(e => out.push(`▫️ ${day(e.created_at)} · ${e.description} · *${money(e.amount)}*`));
  else out.push('_אין חובות פתוחים_');
  if (payments.length) {
    out.push('', `✅ *תשלומים שהתקבלו*`, line);
    payments.forEach(e => out.push(`▫️ ${day(e.created_at)} · ${e.description} · *−${money(e.amount)}*`));
  }
  out.push(line);
  out.push(balance > 0 ? `💰 *יתרה לתשלום: ${money(balance)}*` : balance < 0 ? `💚 *יתרת זכות: ${money(balance)}*` : '✅ *החשבון מאופס, תודה!*');
  if (settings.footer) out.push('', settings.footer);
  out.push('', '_תודה רבה!_ 🙏');
  return out.join('\n');
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

// --- Settings ---
app.get('/api/settings', wrap(async (req, res) => res.json(await getSettings())));

app.put('/api/settings', wrap(async (req, res) => {
  for (const key of SETTING_KEYS) {
    if (typeof req.body[key] !== 'string') continue;
    const value = req.body[key].trim().slice(0, 1000);
    await pool.query('DELETE FROM settings WHERE key = $1', [key]);
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, value]);
  }
  res.json(await getSettings());
}));

// --- WhatsApp ---
app.get('/api/whatsapp/status', (req, res) => res.json(wa.status()));
app.post('/api/whatsapp/connect', (req, res) => { wa.start(); res.json(wa.status()); });
app.post('/api/whatsapp/logout', wrap(async (req, res) => { await wa.logout(); res.json(wa.status()); }));

async function loadStatement(id) {
  const c = await pool.query('SELECT id, name, phone FROM customers WHERE id = $1', [id]);
  if (!c.rows.length) return null;
  const e = await pool.query(
    'SELECT description, amount, created_at, paid_at FROM entries WHERE customer_id = $1 ORDER BY created_at DESC, id DESC', [id]);
  const entries = e.rows.map(r => ({ ...r, amount: toNum(r.amount) }));
  return { customer: c.rows[0], text: buildStatement(c.rows[0], entries, await getSettings()) };
}

app.get('/api/customers/:id/statement', wrap(async (req, res) => {
  const s = await loadStatement(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'לקוח לא נמצא' });
  res.json({ text: s.text, phone: s.customer.phone });
}));

app.post('/api/customers/:id/send', wrap(async (req, res) => {
  const s = await loadStatement(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'לקוח לא נמצא' });
  try {
    await wa.send(s.customer.phone, s.text);
  } catch (err) {
    if (err instanceof wa.UserError) return res.status(400).json({ error: err.message });
    throw err;
  }
  res.json({ ok: true });
}));

app.get('/api/customers', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.phone,
           COALESCE(SUM(CASE WHEN e.paid_at IS NULL THEN e.amount ELSE 0 END), 0) AS balance,
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
    'SELECT id, description, amount, created_at, paid_at FROM entries WHERE customer_id = $1 ORDER BY created_at DESC, id DESC', [id]);
  const entries = e.rows.map(r => ({ ...r, amount: toNum(r.amount) }));
  const balance = entries.reduce((s, r) => s + (r.paid_at ? 0 : r.amount), 0);
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

app.put('/api/entries/:id/paid', wrap(async (req, res) => {
  const paid = req.body.paid !== false;
  const { rowCount } = await pool.query(
    `UPDATE entries SET paid_at = ${paid ? 'NOW()' : 'NULL'} WHERE id = $1 AND amount > 0`, [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'רשומה לא נמצאה' });
  res.json({ ok: true });
}));

app.delete('/api/entries/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM entries WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public')));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    wa.startIfSaved();
  })
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
