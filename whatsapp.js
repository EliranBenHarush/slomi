// WhatsApp connection via whatsapp-web.js (runs a headless Chromium logged in to your WhatsApp)
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const DATA_PATH = process.env.WA_DATA_PATH || path.join(__dirname, '.wwebjs_auth');
const SESSION_DIR = path.join(DATA_PATH, 'session');
const READY_FLAG = path.join(DATA_PATH, 'linked'); // written once a login succeeded

let client = null;
let state = { status: 'disconnected', qr: null, error: null, me: null };

const reset = (error = null) => { state = { status: 'disconnected', qr: null, error, me: null }; };

let patched = false;

// When restoring a saved session, WhatsApp Web reloads itself mid-login. whatsapp-web.js then
// evaluates code on a page whose modules aren't loaded yet and crashes with
// "Cannot read properties of null (reading 'Socket')" or "Execution context was destroyed".
// Make every page.evaluate wait for WhatsApp's modules and retry on those errors.
const RETRYABLE = /reading 'Socket'|Execution context was destroyed|Cannot find context/;

function waitForWhatsApp(page) {
  return page.waitForFunction(() => {
    try { return !!window.require('WAWebSocketModel').Socket; } catch { return false; }
  }, { timeout: 60000, polling: 300 }).catch(() => {});
}

function patchInject(Client) {
  if (patched) return;
  patched = true;
  const original = Client.prototype.inject;
  Client.prototype.inject = async function () {
    const page = this.pupPage;
    if (!page.__retryPatched) {
      page.__retryPatched = true;
      const evaluate = page.evaluate.bind(page);
      page.evaluate = async (...args) => {
        for (let i = 0; ; i++) {
          try {
            return await evaluate(...args);
          } catch (err) {
            if (i >= 6 || !RETRYABLE.test(String(err?.message || err))) throw err;
            await new Promise(r => setTimeout(r, 1000));
            await waitForWhatsApp(page);
          }
        }
      };
    }
    await waitForWhatsApp(page);
    return original.call(this);
  };
}

// Chromium leaves Singleton* lock files in the profile. After a redeploy they point at the old
// container, and Chromium refuses to open the profile ("profile appears to be in use").
function clearProfileLocks() {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(SESSION_DIR, f), { force: true }); } catch {}
  }
}

function start(attempt = 1) {
  if (client) return;
  const { Client, LocalAuth } = require('whatsapp-web.js');
  patchInject(Client);
  clearProfileLocks();
  state = { status: 'loading', qr: null, error: null, me: null };
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_PATH }),
    // The library default (Chrome 101) is too old for WhatsApp Web, which keeps reloading the page
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    },
  });

  client.on('qr', async qr => {
    state.status = 'qr';
    state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
  });
  client.on('authenticated', () => { state.status = 'loading'; state.qr = null; });
  client.on('ready', () => {
    state.status = 'ready';
    state.qr = null;
    state.me = client.info?.wid?.user || null;
    fs.writeFileSync(READY_FLAG, new Date().toISOString());
  });
  client.on('auth_failure', () => reset('ההתחברות נכשלה, נסה שוב'));
  client.on('disconnected', async () => {
    const c = client;
    client = null;
    reset();
    try { await c.destroy(); } catch {}
  });

  const c = client;
  c.initialize().catch(async err => {
    console.error(`WhatsApp init failed (attempt ${attempt}):`, String(err?.stack || err).slice(0, 600));
    try { await c.destroy(); } catch {}
    if (client !== c) return;
    client = null;
    // WhatsApp Web sometimes reloads itself during the first load; retrying usually works
    if (attempt < 4) setTimeout(() => start(attempt + 1), 3000);
    else reset('החיבור נכשל. נסה "איפוס חיבור" וסריקה מחדש');
  });
}

// Reconnect automatically after a restart if a saved session exists
function startIfSaved() {
  if (fs.existsSync(READY_FLAG) && fs.existsSync(SESSION_DIR)) start();
}

async function logout() {
  const c = client;
  client = null;
  if (c) {
    try { await c.logout(); } catch {}
    try { await c.destroy(); } catch {}
  }
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.rmSync(READY_FLAG, { force: true });
  reset();
}

class UserError extends Error {}

async function send(phone, text) {
  if (!client || state.status !== 'ready') throw new UserError('וואטסאפ לא מחובר. יש להתחבר במסך ההגדרות');
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new UserError('ללקוח אין מספר טלפון');
  const intl = digits.startsWith('0') ? '972' + digits.slice(1) : digits;
  const id = await client.getNumberId(intl);
  if (!id) throw new UserError('המספר הזה לא רשום בוואטסאפ');
  await client.sendMessage(id._serialized, text);
}

module.exports = { start, startIfSaved, logout, send, status: () => state, UserError };
