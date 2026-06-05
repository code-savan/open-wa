const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { scrapeGoogleMaps } = require('./scraper');
const { getSheetData } = require('./dashboard');
const tracker = require('./tracker');
const QRCode = require('qrcode');
const { appendRows, writeRange } = require('./sheet-utils');

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
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=site-per-process',
      '--disable-blink-features=AutomationControlled',
      '--disable-default-apps',
      '--no-first-run',
      '--renderer-process-limit=1',
      '--disable-accelerated-2d-canvas',
      '--disk-cache-size=1048576',
      '--max_connections_per_server=0',
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
  const isFromMe = msg.fromMe || msg._data?.fromMe;
  if (!isFromMe) {
    tracker.add('message_replied', { from: msg.from, body: msg.body.slice(0, 50) });
  }
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

app.get('/qr-page', async (_req, res) => {
  if (!qrCodeString) {
    if (client) return res.send('<html><body style="background:#0a0a0b;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Already connected</p></body></html>');
    return res.send('<html><body style="background:#0a0a0b;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>QR not ready yet, refresh in a few seconds</p></body></html>');
  }
  try {
    const dataUrl = await QRCode.toDataURL(qrCodeString, { width: 400, margin: 2 });
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Scan QR</title>
<style>body{background:#0a0a0b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center}img{max-width:360px;border-radius:12px;box-shadow:0 0 40px rgba(139,92,246,.2)}h2{font-size:18px;font-weight:500;margin-bottom:8px}p{font-size:13px;color:#71717a;max-width:320px;line-height:1.5}.auto-refresh{font-size:12px;color:#52525b;margin-top:24px}</style>
</head>
<body>
<h2>Scan with WhatsApp</h2>
<p>Open WhatsApp on your phone → Linked Devices → Link a Device</p>
<img src="${dataUrl}" alt="QR Code">
<p class="auto-refresh">Auto-refreshing...</p>
<script>setTimeout(()=>location.reload(),5000)</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(err.message);
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
    tracker.add('message_sent', { to: phone, body: message.slice(0, 50) });
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
    tracker.add('scrape_done', { count: allResults.length, queries });
    if (allResults.length > 0) {
      await appendToSheet(allResults).catch(e => console.log('[Scrape] Sheet append error:', e.message));
    }
    res.json({ count: allResults.length, results: allResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/format-sheet', async (_req, res) => {
  try {
    const rows = await getSheetData(SHEET_ID);
    let headerRow = rows[0] || [];
    const dataRows = rows.slice(1);

    const headerMap = {};
    EXPECTED_HEADERS.forEach(h => {
      const idx = headerRow.findIndex(c => c.toLowerCase().trim() === h);
      if (idx >= 0) headerMap[h] = idx;
    });

    // If detection failed, assume sequential order starting at col 0
    if (Object.keys(headerMap).length < 3) {
      EXPECTED_HEADERS.forEach((h, i) => { if (i < headerRow.length) headerMap[h] = i; });
    }

    const cleaned = dataRows.map(row => {
      const obj = {};
      EXPECTED_HEADERS.forEach(h => {
        const idx = headerMap[h];
        let val = (idx !== undefined && idx < row.length) ? String(row[idx] || '') : '';
        if (h === 'phone') {
          val = val.replace(/[^0-9]/g, '');
          if (val.length > 11 && val.startsWith('234')) val = val.slice(-11);
          if (val.length === 11 && val.startsWith('0')) val = '234' + val.slice(1);
          if (val.length === 10) val = '234' + val;
        }
        if (h === 'business_name') val = val.trim();
        if (h === 'scraped_at' && !val) val = new Date().toISOString();
        obj[h] = val;
      });
      return obj;
    }).filter(r => r.business_name);

    const outputRows = [EXPECTED_HEADERS];
    cleaned.forEach(r => outputRows.push(EXPECTED_HEADERS.map(h => r[h])));
    await writeRange(SHEET_ID, 'Sheet1!A1', outputRows);

    res.json({
      message: 'Sheet formatted',
      headers_detected: headerMap,
      total_rows: rows.length,
      cleaned_rows: cleaned.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-sheet', async (_req, res) => {
  try {
    await writeRange(SHEET_ID, 'Sheet1!A1', [EXPECTED_HEADERS]);
    res.json({ message: 'Sheet reset to clean headers', headers: EXPECTED_HEADERS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const sheetId = '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const rows = await getSheetData(sheetId);
    let total = 0, byStatus = {}, byCity = {}, byNiche = {}, recent = [];
    if (rows && rows.length >= 2) {
      const headers = rows[0];
      const data = rows.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, i) => obj[h.trim()] = (r[i] || '').trim());
        return obj;
      });
      const valid = data.filter(r => r.business_name);
      total = valid.length;
      valid.forEach(r => {
        byStatus[r.status || 'new'] = (byStatus[r.status || 'new'] || 0) + 1;
        byCity[r.city || 'unknown'] = (byCity[r.city || 'unknown'] || 0) + 1;
        byNiche[r.niche || 'unknown'] = (byNiche[r.niche || 'unknown'] || 0) + 1;
      });
      recent = valid.slice(-20).reverse();
    }
    const auto = tracker.getStats();
    const timeline = tracker.getAll(30);
    res.json({ total, byStatus, byCity, byNiche, recent, auto, timeline });
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
<title>Morrnaire — Automation Dashboard</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0a0b; color:#e4e4e7; padding:32px; }
h1 { font-size:20px; font-weight:600; color:#fff; }
h1 span { color:#8b5cf6; }
.header { display:flex; justify-content:space-between; align-items:center; margin-bottom:32px; }
.header-right { font-size:12px; color:#52525b; }
.section-title { font-size:13px; font-weight:600; color:#71717a; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:16px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:32px; }
.card { background:#141416; border-radius:10px; padding:16px; border:1px solid #1f1f23; }
.card .val { font-size:28px; font-weight:700; color:#fff; line-height:1.2; }
.card .lbl { font-size:12px; color:#71717a; margin-top:4px; }
.card-auto { border-left:3px solid #8b5cf6; }
.card-lead { border-left:3px solid #3b82f6; }
.card-msg { border-left:3px solid #22c55e; }
.card-err { border-left:3px solid #ef4444; }
.row { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:32px; }
@media(max-width:768px){ .row { grid-template-columns:1fr; } }
.panel { background:#141416; border-radius:10px; padding:20px; border:1px solid #1f1f23; }
.timeline { max-height:400px; overflow-y:auto; }
.timeline::-webkit-scrollbar { width:4px; }
.timeline::-webkit-scrollbar-thumb { background:#27272a; border-radius:2px; }
.event { display:flex; gap:12px; padding:8px 0; border-bottom:1px solid #1a1a1e; }
.event:last-child { border-bottom:none; }
.event-icon { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; }
.icon-scrape { background:#1e1b4b; color:#8b5cf6; }
.icon-sent { background:#052e16; color:#22c55e; }
.icon-reply { background:#1e0a3a; color:#d946ef; }
.icon-error { background:#2e0a0a; color:#ef4444; }
.event-body { flex:1; min-width:0; }
.event-title { font-size:13px; font-weight:500; color:#e4e4e7; }
.event-desc { font-size:12px; color:#71717a; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.event-time { font-size:11px; color:#52525b; margin-top:2px; }
.bar { display:flex; align-items:center; margin-bottom:6px; }
.bar .key { width:120px; font-size:12px; color:#a1a1aa; flex-shrink:0; }
.bar .track { flex:1; height:16px; background:#1f1f23; border-radius:8px; overflow:hidden; }
.bar .fill { height:100%; background:linear-gradient(90deg,#6366f1,#8b5cf6); border-radius:8px; transition:width .5s; }
.bar .count { width:36px; text-align:right; font-size:12px; color:#71717a; margin-left:8px; flex-shrink:0; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; color:#71717a; font-weight:500; padding:6px 8px; border-bottom:1px solid #1f1f23; }
td { padding:6px 8px; border-bottom:1px solid #16161a; color:#a1a1aa; }
.badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:500; }
.badge-new { background:#1e1b4b; color:#818cf8; }
.badge-sent { background:#052e16; color:#4ade80; }
.badge-replied { background:#1e0a3a; color:#d946ef; }
.error { color:#ef4444; text-align:center; padding:40px; }
.loading { text-align:center; padding:40px; color:#52525b; font-size:14px; }
.empty { text-align:center; padding:20px; color:#52525b; font-size:13px; }
</style>
</head>
<body>
<div class="header">
  <h1>Morrnaire <span>Automation</span></h1>
  <div class="header-right" id="lastUpdated"></div>
</div>
<div id="app"><div class="loading">Loading dashboard...</div></div>
<script>
const T = { scrape:'SCRAPE', sent:'SENT', reply:'REPLY', error:'ERROR' };
async function load() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();
    if (d.error) { document.getElementById('app').innerHTML = '<div class="error">'+d.error+'</div>'; return; }
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    document.getElementById('app').innerHTML = render(d);
  } catch(e) {
    document.getElementById('app').innerHTML = '<div class="error">Failed to load: '+e.message+'</div>';
  }
}
function render(d) {
  const a = d.auto || {};
  return \`
    <div class="section-title">Automation Overview</div>
    <div class="cards">
      <div class="card card-auto"><div class="val">\${a.total_scrapes||0}</div><div class="lbl">Scrapes Run</div></div>
      <div class="card card-auto"><div class="val">\${a.total_leads_found||0}</div><div class="lbl">Leads Found</div></div>
      <div class="card card-msg"><div class="val">\${a.total_messages_sent||0}</div><div class="lbl">Messages Sent</div></div>
      <div class="card card-msg"><div class="val">\${a.total_messages_replied||0}</div><div class="lbl">Replies Received</div></div>
      <div class="card card-err"><div class="val">\${a.total_errors||0}</div><div class="lbl">Errors</div></div>
    </div>
    <div class="section-title">Leads Overview</div>
    <div class="cards">
      <div class="card card-lead"><div class="val">\${d.total}</div><div class="lbl">Total Leads</div></div>
      <div class="card card-lead"><div class="val">\${d.byStatus.new||0}</div><div class="lbl">New</div></div>
      <div class="card card-lead"><div class="val">\${d.byStatus.sent||0}</div><div class="lbl">Messaged</div></div>
      <div class="card card-lead"><div class="val">\${d.byStatus.replied||0}</div><div class="lbl">Replied</div></div>
    </div>
    <div class="row">
      <div class="panel">
        <div class="section-title">Activity Timeline</div>
        <div class="timeline">\${renderTimeline(d.timeline||[])}</div>
      </div>
      <div class="panel">
        <div class="section-title">Leads by City</div>
        \${bars(d.byCity)}
        <div class="section-title" style="margin-top:20px">Leads by Niche</div>
        \${bars(d.byNiche)}
      </div>
    </div>
    <div class="panel">
      <div class="section-title">Recent Leads</div>
      \${d.recent.length ? '<table><tr><th>Name</th><th>Phone</th><th>City</th><th>Status</th></tr>'+d.recent.map(r=>'<tr><td>'+esc(r.business_name)+'</td><td>'+esc(r.phone)+'</td><td>'+esc(r.city)+'</td><td><span class="badge badge-'+(r.status||'new')+'">'+esc(r.status||'new')+'</span></td></tr>').join('')+'</table>' : '<div class="empty">No leads yet</div>'}
    </div>
  \`;
}
function renderTimeline(events) {
  if (!events.length) return '<div class="empty">No activity yet</div>';
  return events.map(e => {
    let icon, title, desc;
    switch(e.type) {
      case 'scrape_done': icon='S'; title='Scrape Complete'; desc=e.count+' leads found'+(e.source?' via '+e.source:''); break;
      case 'scrape_start': icon='S'; title='Scrape Started'; desc=''; break;
      case 'message_sent': icon='M'; title='Message Sent'; desc='To '+esc(e.to); break;
      case 'message_replied': icon='R'; title='Reply Received'; desc='From '+esc(e.from)+': "'+esc(e.body)+'"'; break;
      case 'error': icon='!'; title='Error'; desc=esc(e.message||e.context); break;
      default: icon='?'; title=e.type; desc='';
    }
    const cls = e.type.includes('scrape')?'icon-scrape':e.type.includes('sent')?'icon-sent':e.type==='message_replied'?'icon-reply':'icon-error';
    const t = new Date(e.time);
    const timeStr = t.toLocaleDateString() + ' ' + t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    return '<div class="event"><div class="event-icon '+cls+'">'+icon+'</div><div class="event-body"><div class="event-title">'+title+'</div><div class="event-desc">'+desc+'</div><div class="event-time">'+timeStr+'</div></div></div>';
  }).join('');
}
function bars(obj) {
  const entries = Object.entries(obj||{}).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return '<div class="empty">No data</div>';
  const max = Math.max(...entries.map(e=>e[1]),1);
  return entries.map(([k,v]) => '<div class="bar"><div class="key">'+esc(k)+'</div><div class="track"><div class="fill" style="width:'+(v/max*100)+'%"></div></div><div class="count">'+v+'</div></div>').join('');
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
load();
setInterval(load, 15000);
</script>
</body>
</html>`);
});

const SCRAPE_HOUR = parseInt(process.env.SCRAPE_HOUR || '8');
const SCRAPE_MINUTE = parseInt(process.env.SCRAPE_MINUTE || '45');
const SCRAPE_N8N_URL = process.env.SCRAPE_N8N_URL || '';

const CITIES = ['Abuja', 'Lagos', 'Port-Harcourt', 'Ibadan', 'Aba', 'Owerri'];
const NICHES = ['beauty spa', 'barber shop', 'private dental clinic', 'suya spot', 'physiotherapy clinic', 'event planner', 'private school'];

const SHEET_ID = '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';

const EXPECTED_HEADERS = ['business_name','phone','address','rating','city','niche','google_maps_url','status','source','scraped_at'];

async function appendToSheet(rows) {
  const values = rows.map(r => EXPECTED_HEADERS.map(h => {
    let v = r[h] || '';
    if (h === 'scraped_at') v = new Date().toISOString();
    return String(v);
  }));
  await appendRows(SHEET_ID, values);
  console.log(`[Sheets] Appended ${values.length} rows`);
}

async function runDailyScrape() {
  console.log(`[Scheduler] Starting daily scrape at ${new Date().toISOString()}`);
  tracker.add('scrape_start', {});
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
    tracker.add('scrape_done', { count: allResults.length, source: 'scheduled' });

    if (allResults.length > 0) {
      await appendToSheet(allResults);
    }

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
    tracker.add('error', { context: 'scrape', message: err.message });
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
