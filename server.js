const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { scrapeGoogleMaps } = require('./scraper');
const { getSheetData } = require('./dashboard');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let client = null;
let qrCodeString = null;

const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: '/root/.wa-session' }),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--single-process',
      '--no-zygote',
    ],
  },
});

waClient.on('qr', (qr) => {
  qrCodeString = qr;
  qrcode.generate(qr, { small: true });
  console.log('=== SCAN THE QR CODE ABOVE with WhatsApp on your phone ===');
  console.log('Go to WhatsApp > Linked Devices > Link a Device');
});

waClient.on('ready', () => {
  client = waClient;
  qrCodeString = null;
  console.log('WhatsApp client is ready!');
});

waClient.on('message', async (msg) => {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from,
        body: msg.body,
        senderName: msg._data?.notifyName || msg.from,
        timestamp: msg.timestamp,
      }),
    });
  } catch (err) {
    console.error('Webhook call failed:', err.message);
  }
});

waClient.initialize();

app.get('/health', (_req, res) => {
  res.json({ status: client ? 'connected' : 'starting', qr: !!qrCodeString });
});

app.get('/qr', (_req, res) => {
  if (qrCodeString) {
    res.json({ qr: qrCodeString });
  } else {
    res.json({ qr: null, message: client ? 'already connected' : 'not ready yet' });
  }
});

app.post('/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }
  if (!client) {
    return res.status(503).json({ error: 'WhatsApp not ready yet' });
  }
  try {
    const formatted = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    await client.sendMessage(formatted, message);
    res.json({ success: true, to: phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/scrape', async (req, res) => {
  const { queries = [], maxPerQuery = 15 } = req.body;
  if (!queries.length) {
    return res.status(400).json({ error: 'queries array required' });
  }
  if (!client) {
    return res.status(503).json({ error: 'WhatsApp not ready yet' });
  }
  try {
    const browser = waClient.pupBrowser;
    if (!browser) {
      return res.status(503).json({ error: 'Browser not ready' });
    }
    const allResults = [];
    for (const { query, city } of queries) {
      const results = await scrapeGoogleMaps({ browser, query, city, maxResults: maxPerQuery });
      allResults.push(...results);
      await sleep(3000 + Math.random() * 2000);
    }
    res.json({ count: allResults.length, results: allResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const sheetId = '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const rows = await getSheetData(sheetId);
    if (!rows || rows.length < 2) {
      return res.json({ total: 0, byStatus: {}, byCity: {}, byNiche: {}, recent: [] });
    }
    const headers = rows[0];
    const data = rows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h.trim()] = (r[i] || '').trim());
      return obj;
    });

    const valid = data.filter(r => r.business_name);
    const byStatus = {};
    const byCity = {};
    const byNiche = {};
    valid.forEach(r => {
      byStatus[r.status || 'new'] = (byStatus[r.status || 'new'] || 0) + 1;
      byCity[r.city || 'unknown'] = (byCity[r.city || 'unknown'] || 0) + 1;
      byNiche[r.niche || 'unknown'] = (byNiche[r.niche || 'unknown'] || 0) + 1;
    });

    const recent = valid.slice(-20).reverse();

    res.json({ total: valid.length, byStatus, byCity, byNiche, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/dashboard', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Morrnaire Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
h1 { font-size: 24px; font-weight: 600; margin-bottom: 24px; color: #fff; }
h2 { font-size: 16px; font-weight: 500; margin-bottom: 12px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
.card { background: #1a1a1a; border-radius: 12px; padding: 20px; border: 1px solid #2a2a2a; }
.card .value { font-size: 32px; font-weight: 700; color: #fff; }
.card .label { font-size: 13px; color: #888; margin-top: 4px; }
.panel { background: #1a1a1a; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid #2a2a2a; }
.bar { display: flex; align-items: center; margin-bottom: 8px; }
.bar .key { width: 140px; font-size: 13px; color: #ccc; }
.bar .track { flex: 1; height: 20px; background: #2a2a2a; border-radius: 10px; overflow: hidden; }
.bar .fill { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); border-radius: 10px; transition: width 0.5s; }
.bar .count { width: 48px; text-align: right; font-size: 13px; color: #888; margin-left: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: #888; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid #2a2a2a; }
td { padding: 8px 12px; border-bottom: 1px solid #222; color: #ccc; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500; }
.badge-new { background: #1e3a5f; color: #60a5fa; }
.badge-sent { background: #1e3a2f; color: #4ade80; }
.badge-replied { background: #3a1e2f; color: #f472b6; }
.error { color: #ef4444; text-align: center; padding: 40px; }
.loading { text-align: center; padding: 40px; color: #666; }
</style>
</head>
<body>
<h1>Morrnaire Dashboard</h1>
<div id="app"><div class="loading">Loading...</div></div>
<script>
async function load() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();
    if (d.error) { document.getElementById('app').innerHTML = '<div class="error">' + d.error + '</div>'; return; }
    document.getElementById('app').innerHTML = render(d);
  } catch(e) {
    document.getElementById('app').innerHTML = '<div class="error">Failed to load: ' + e.message + '</div>';
  }
}
function render(d) {
  return \`
    <div class="cards">
      <div class="card"><div class="value">\${d.total}</div><div class="label">Total Leads</div></div>
      <div class="card"><div class="value">\${d.byStatus.new || 0}</div><div class="label">New</div></div>
      <div class="card"><div class="value">\${d.byStatus.sent || 0}</div><div class="label">Sent</div></div>
      <div class="card"><div class="value">\${d.byStatus.replied || 0}</div><div class="label">Replied</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
      <div class="panel"><h2>By City</h2>\${bars(d.byCity)}</div>
      <div class="panel"><h2>By Niche</h2>\${bars(d.byNiche)}</div>
    </div>
    <div class="panel"><h2>Recent Leads</h2>
      <table><tr><th>Name</th><th>Phone</th><th>City</th><th>Status</th><th>Sent</th></tr>
      \${d.recent.map(r => '<tr><td>' + esc(r.business_name) + '</td><td>' + esc(r.phone) + '</td><td>' + esc(r.city) + '</td><td><span class="badge badge-' + (r.status||'new') + '">' + esc(r.status) + '</span></td><td>' + esc(r.sent_at || '') + '</td></tr>').join('')}
      </table>
    </div>
  \`;
}
function bars(obj) {
  const entries = Object.entries(obj).sort((a,b) => b[1]-a[1]);
  const max = Math.max(...entries.map(e => e[1]), 1);
  return entries.map(([k,v]) => '<div class="bar"><div class="key">' + esc(k) + '</div><div class="track"><div class="fill" style="width:' + (v/max*100) + '%"></div></div><div class="count">' + v + '</div></div>').join('');
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
load();
</script>
</body>
</html>`);
});

const SCRAPE_HOUR = parseInt(process.env.SCRAPE_HOUR || '8');
const SCRAPE_MINUTE = parseInt(process.env.SCRAPE_MINUTE || '45');
const SCRAPE_N8N_URL = process.env.SCRAPE_N8N_URL || '';

const CITIES = ['Abuja', 'Lagos', 'Port-Harcourt', 'Ibadan', 'Aba', 'Owerri'];
const NICHES = ['beauty spa', 'barber shop', 'private dental clinic', 'suya spot', 'physiotherapy clinic', 'event planner', 'private school'];

async function runDailyScrape() {
  console.log(`[Scheduler] Starting daily scrape at ${new Date().toISOString()}`);
  try {
    const browser = waClient.pupBrowser;
    if (!browser) { console.log('[Scheduler] Browser not ready'); return; }

    const allResults = [];
    for (const city of CITIES) {
      for (const niche of NICHES) {
        const results = await scrapeGoogleMaps({ browser, query: niche, city, maxResults: 8 });
        allResults.push(...results);
        await sleep(4000 + Math.random() * 3000);
      }
    }
    console.log(`[Scheduler] Scraped ${allResults.length} leads total`);

    if (SCRAPE_N8N_URL && allResults.length > 0) {
      await fetch(SCRAPE_N8N_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: allResults.length, results: allResults }),
      });
      console.log(`[Scheduler] Sent results to N8N`);
    }
  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
  }
}

setInterval(() => {
  const now = new Date();
  const hour = now.getUTCHours() + 1; // Africa/Lagos = UTC+1
  const minute = now.getMinutes();
  if (hour === SCRAPE_HOUR && minute === SCRAPE_MINUTE) {
    runDailyScrape();
  }
}, 60000);
console.log(`[Scheduler] Will run daily at ${SCRAPE_HOUR}:${String(SCRAPE_MINUTE).padStart(2,'0')} Lagos time`);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Session path: /root/.wa-session`);
  if (WEBHOOK_URL) console.log(`Webhook: ${WEBHOOK_URL}`);
});
