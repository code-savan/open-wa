const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { getSheetData } = require('./dashboard');
const tracker = require('./tracker');
const QRCode = require('qrcode');
const { appendRows, writeRange, clearSheet, getSheetInfo, addSheet, ensureSheetWithHeaders } = require('./sheet-utils');
const { normalizePhone, parsePhones } = require('./phone-utils');
const autoSender = require('./auto-sender');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// In-memory tracking of sent msg1: phone -> { business_name, niche, sheet }
const sentMessages = new Map();

const MSG2_TEMPLATES = {
  spa: `Thanks for responding! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build professional websites for beauty businesses here in [City]. A few salons we've worked with started getting more bookings and walk-ins within weeks of going live. 

We actually went ahead and built a quick demo site for [BusinessName] — no cost to you, no obligation. Mind if I send it over? Takes 30 seconds to view. 🙏`,
  law: `Appreciate you getting back! I'm Marvellous from Morrnaire (morrnaire.com.ng). We build clean, trust-first websites for law firms and chambers across Nigeria. Clients who had no web presence before us have told us it changed how serious prospects perceive them. 

We put together a quick demo site for [BusinessName] — completely free, no strings. Would you like me to send the link? 🙏`,
  realestate: `Appreciate you getting back! I'm Marvellous from Morrnaire (morrnaire.com.ng). We build clean, trust-first websites for law firms and chambers across Nigeria. Clients who had no web presence before us have told us it changed how serious prospects perceive them. 

We put together a quick demo site for [BusinessName] — completely free, no strings. Would you like me to send the link? 🙏`,
  restaurant: `Thanks for responding! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build professional websites for restaurants and food businesses here in [City]. A few places we've worked with started getting more orders and walk-ins within weeks of going live.

We actually went ahead and built a quick demo site for [BusinessName] — no cost to you, no obligation. Mind if I send it over? Takes 30 seconds to view. 🙏`,
  gym: `Thanks for getting back! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build professional websites for fitness businesses here in [City]. Gyms we've worked with have told us their membership sign-ups went up after going live.

We actually went ahead and built a quick demo site for [BusinessName] — completely free, no strings. Mind if I send the link? 🙏`,
  fashion: `Thanks for responding! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build beautiful catalog websites for fashion brands here in [City]. Boutiques we've worked with started getting more enquiries and orders within weeks.

We actually went ahead and built a quick demo site for [BusinessName] — no cost, no obligation. Mind if I send it over? 🙏`,
  hotel: `Thanks for getting back! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build booking-ready websites for hotels and lodges here in [City]. Properties we've worked with started getting more direct bookings after going live.

We put together a quick demo site for [BusinessName] — completely free, no strings. Would you like me to send the link? 🙏`,
  photography: `Thanks for responding! I'm Marvellous from Morrnaire (morrnaire.com.ng) — we build stunning portfolio websites for photographers here in [City]. Photographers we've worked with tell us they book more clients since going live.

We actually went ahead and built a quick demo site for [BusinessName] — no cost, no obligation. Mind if I send it over? 🙏`,
};

function getMsg2Template(niche, businessName, location) {
  const key = (niche || '').toLowerCase();
  let tmpl = MSG2_TEMPLATES.spa;
  if (key.includes('law') || key.includes('chamber') || key.includes('legal')) tmpl = MSG2_TEMPLATES.law;
  else if (key.includes('real') || key.includes('estate') || key.includes('property')) tmpl = MSG2_TEMPLATES.realestate;
  else if (key.includes('restaurant') || key.includes('food') || key.includes('catering')) tmpl = MSG2_TEMPLATES.restaurant;
  else if (key.includes('gym') || key.includes('fitness') || key.includes('gym')) tmpl = MSG2_TEMPLATES.gym;
  else if (key.includes('fashion') || key.includes('boutique') || key.includes('cloth')) tmpl = MSG2_TEMPLATES.fashion;
  else if (key.includes('hotel') || key.includes('lodge') || key.includes('guest')) tmpl = MSG2_TEMPLATES.hotel;
  else if (key.includes('photo') || key.includes('photo') || key.includes('video')) tmpl = MSG2_TEMPLATES.photography;
  return tmpl.replace(/\[BusinessName\]/g, businessName || 'your business')
             .replace(/\[City\]/g, location || 'Nigeria');
}

function lookupPhoneInSheet(rows, phoneRaw) {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const headers = rows[0];
  const nameIdx = headers.findIndex(h => /name/i.test(h));
  const phoneIdx = headers.findIndex(h => /phone|tel|mobile|number|whatsapp/i.test(h));
  const nicheIdx = headers.findIndex(h => /niche|category|type|service|industry/i.test(h));
  const locationIdx = headers.findIndex(h => /location|city|town|address/i.test(h));
  const statusIdx = headers.findIndex(h => /status/i.test(h));
  if (phoneIdx < 0) return null;

  for (let r = 1; r < rows.length; r++) {
    const phones = parsePhones(rows[r][phoneIdx] || '');
    if (phones.includes(phone)) {
      return {
        row: r,
        business_name: nameIdx >= 0 ? (rows[r][nameIdx] || '') : '',
        niche: nicheIdx >= 0 ? (rows[r][nicheIdx] || '') : '',
        location: locationIdx >= 0 ? (rows[r][locationIdx] || '') : '',
        status: statusIdx >= 0 ? (rows[r][statusIdx] || '') : '',
        phoneIdx,
        statusIdx,
        phone,
      };
    }
  }
  return null;
}

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

app.post('/api/run-today', async (_req, res) => {
  if (!client) return res.status(503).json({ error: 'WhatsApp not ready' });
  const result = await autoSender.startAutomation(client);
  res.json(result);
});

app.get('/api/auto-status', (_req, res) => {
  res.json(autoSender.getStatus());
});


waClient.on('ready', () => {
  client = waClient;
  qrCodeString = null;
  console.log('WhatsApp client is ready!');
  autoSender.startTicker(client);
});

waClient.on('message', async (msg) => {
  const isFromMe = msg.fromMe || msg._data?.fromMe;
  if (!isFromMe) {
    tracker.add('message_replied', { from: msg.from, body: msg.body.slice(0, 50) });

    // Check if this is a lead who received msg1 → auto-send msg2
    try {
      const senderPhone = msg.from.replace('@c.us', '').replace('@g.us', '');
      let leadInfo = sentMessages.get(senderPhone);

      if (!leadInfo) {
        // Fallback: scan all sheets for this phone
        const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
        const info = await getSheetInfo(sheetId);
        for (const s of (info.sheets || [])) {
          const title = s.properties.title;
          const rows = await getSheetData(sheetId, `${title}!A1:Z${Math.min(s.properties.gridProperties.rowCount, 200)}`);
          if (rows.length < 2) continue;
          const found = lookupPhoneInSheet(rows, senderPhone);
          if (found && found.status === 'msg1_sent') {
            leadInfo = { ...found, sheet: title };
            break;
          }
        }
      }

      if (leadInfo && leadInfo.status === 'msg1_sent') {
        const msg2 = getMsg2Template(leadInfo.niche, leadInfo.business_name, leadInfo.location);
        const waId = `${senderPhone}@c.us`;
        await client.sendMessage(waId, msg2);
        tracker.add('message_sent', { to: senderPhone, body: msg2.slice(0, 50), type: 'msg2' });
        console.log(`[Auto] Sent msg2 to ${senderPhone} (${leadInfo.business_name})`);

        // Update sheet status
        if (leadInfo.sheet && leadInfo.statusIdx >= 0) {
          try {
            const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
            await writeRange(sheetId, `${leadInfo.sheet}!${String.fromCharCode(65 + leadInfo.statusIdx)}${leadInfo.row + 1}`, [['msg2_sent']]);
          } catch (e) {
            console.log('[Auto] Failed to update sheet status:', e.message);
          }
        }
        sentMessages.delete(senderPhone);
      }
    } catch (e) {
      console.log('[Auto] Reply handler error:', e.message);
    }
  }

  // Forward to n8n webhook
  if (!WEBHOOK_URL && !N8N_WEBHOOK_URL) return;
  const hookUrl = N8N_WEBHOOK_URL || WEBHOOK_URL;
  try {
    await fetch(hookUrl, {
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
  const { phone, message, business_name, niche, location, sheet } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }
  if (!client) {
    return res.status(503).json({ error: 'WhatsApp not ready yet' });
  }
  try {
    const phones = parsePhones(phone);
    if (!phones.length) {
      return res.status(400).json({ error: 'No valid phone numbers found', original: phone });
    }

    const results = [];
    for (const p of phones) {
      try {
        const waId = `${p}@c.us`;
        await client.sendMessage(waId, message);
        sentMessages.set(p, { business_name: business_name || '', niche: niche || '', location: location || '', sheet: sheet || '' });
        tracker.add('message_sent', { to: p, body: message.slice(0, 50) });
        results.push({ phone: p, success: true });
        // Small delay between sending to multiple numbers
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        results.push({ phone: p, success: false, error: e.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-sheets', async (_req, res) => {
  try {
    const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const niches = [
      'Restaurant',
      'Gym & Fitness',
      'Fashion Boutique',
      'Hotel & Lodge',
      'Photography',
    ];
    const headers = ['Name', 'Niche', 'Phone', 'Location', 'status'];
    const created = [];
    for (const niche of niches) {
      try {
        await ensureSheetWithHeaders(sheetId, niche, headers);
        created.push(niche);
      } catch (e) {
        console.log(`[Sheets] Error creating ${niche}:`, e.message);
      }
    }
    res.json({ message: 'Sheets created', created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sheet-info', async (_req, res) => {
  try {
    const info = await getSheetInfo('1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc');
    const sheets = (info.sheets || []).map(s => ({
      title: s.properties.title,
      rows: s.properties.gridProperties.rowCount,
      cols: s.properties.gridProperties.columnCount,
    }));
    // Read first 5 rows from each sheet
    const preview = {};
    for (const s of sheets) {
      const data = await getSheetData('1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc', `${s.title}!A1:Z5`);
      preview[s.title] = data;
    }
    res.json({ sheets, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const info = await getSheetInfo(sheetId);
    const byTab = {};
    let total = 0;
    for (const s of (info.sheets || [])) {
      const title = s.properties.title;
      const rows = await getSheetData(sheetId, `${title}!A1:Z${Math.min(s.properties.gridProperties.rowCount, 300)}`);
      if (rows.length < 2) { byTab[title] = { total: 0 }; continue; }
      const headers = rows[0];
      const statusIdx = headers.findIndex(h => /status/i.test(h));
      const data = rows.slice(1).filter(r => r[0] && r[0].trim());
      byTab[title] = { total: data.length };
      if (statusIdx >= 0) {
        const byStatus = {};
        data.forEach(r => {
          const st = (r[statusIdx] || 'new').trim().toLowerCase() || 'new';
          byStatus[st] = (byStatus[st] || 0) + 1;
        });
        byTab[title].byStatus = byStatus;
      }
      total += data.length;
    }
    const auto = tracker.getStats();
    const timeline = tracker.getAll(30);
    res.json({ total, byTab, auto, timeline });
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
async function load() {
  try {
    const [sr, ar] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/auto-status').then(r => r.json()),
    ]);
    if (sr.error) { document.getElementById('app').innerHTML = '<div class="error">'+sr.error+'</div>'; return; }
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    document.getElementById('app').innerHTML = render(sr, ar);
  } catch(e) {
    document.getElementById('app').innerHTML = '<div class="error">Failed to load: '+e.message+'</div>';
  }
}

function render(d, a) {
  const auto = a;
  const pct = auto.dailyCap > 0 ? Math.round(auto.sent / auto.dailyCap * 100) : 0;
  const statusColors = { idle:'#f59e0b', sending:'#8b5cf6', cooldown:'#3b82f6', completed:'#22c55e', weekend:'#71717a', outside_window:'#71717a', no_leads:'#ef4444' };
  const sc = statusColors[auto.sendStatus] || '#f59e0b';
  const statusLabels = { idle:'Waiting', sending:'Sending...', cooldown:'Cooldown', completed:'Done ✓', weekend:'Weekend Off', outside_window:'Outside Window', no_leads:'No Leads' };
  const sl = statusLabels[auto.sendStatus] || 'Idle';
  const nextTime = auto.nextAction ? new Date(auto.nextAction).toLocaleTimeString() : '—';

  return \`
    <div class="section-title">Warming Schedule — Week \${auto.warmingWeek} of \${auto.maxWarmingWeek}</div>
    <div class="cards">
      <div class="card card-auto"><div class="val" style="color:\${sc}">\${sl}</div><div class="lbl">\${auto.day} — Status</div></div>
      <div class="card card-msg"><div class="val">\${auto.sent} / \${auto.dailyCap}</div><div class="lbl">Today's Cap</div></div>
      <div class="card card-msg"><div class="val">\${auto.window}</div><div class="lbl">Send Window</div></div>
      <div class="card card-auto"><div class="val">\${auto.remaining}</div><div class="lbl">Remaining Today</div></div>
    </div>
    <div style="background:#141416;border-radius:10px;padding:20px;border:1px solid #1f1f23;margin-bottom:32px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#71717a;margin-bottom:6px">
        <span>Progress</span><span>\${auto.sent} / \${auto.dailyCap}</span>
      </div>
      <div style="height:8px;background:#1f1f23;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:\${pct}%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:4px;transition:width 1s"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;font-size:12px;color:#52525b">
        <div>Batch: <span style="color:#a1a1aa">\${auto.batchSize} msgs</span></div>
        <div>Gap: <span style="color:#a1a1aa">\${auto.gapRange}</span></div>
        <div>Cooldown: <span style="color:#a1a1aa">\${auto.cooldownRange}</span></div>
        <div>Next: <span style="color:#a1a1aa">\${nextTime}</span></div>
      </div>
      \${auto.current && !auto.current.includes('idle') ? '<div style="margin-top:8px;font-size:12px;color:#52525b">'+esc(auto.current)+'</div>' : ''}
    </div>
    <div class="section-title">Leads by Niche</div>
    <div class="cards" id="nicheCards"></div>
    <div class="row">
      <div class="panel">
        <div class="section-title">Activity Timeline</div>
        <div class="timeline">\${renderTimeline(d.timeline||[])}</div>
      </div>
      <div class="panel" id="nicheDetail"></div>
    </div>
  \`;
  renderNicheCards(d.byTab);
}
function renderNicheCards(byTab) {
  const container = document.getElementById('nicheCards');
  const detail = document.getElementById('nicheDetail');
  if (!byTab || !Object.keys(byTab).length) {
    container.innerHTML = '<div class="card card-lead"><div class="val">0</div><div class="lbl">No sheets found</div></div>';
    return;
  }
  let html = '';
  let detailHtml = '<div class="section-title">Status Breakdown</div>';
  Object.entries(byTab).forEach(([name, info]) => {
    const st = info.byStatus || {};
    const newCount = st.new || st[''] || 0;
    const sentCount = st.msg1_sent || 0;
    const repliedCount = st.msg2_sent || 0;
    html += '<div class="card card-lead"><div class="val">'+info.total+'</div><div class="lbl">'+esc(name)+'</div></div>';
    detailHtml += '<div style="margin-top:12px"><div class="bar" style="margin-bottom:4px"><div class="key" style="width:160px">'+esc(name)+'</div><div class="track"><div class="fill" style="width:100%"></div></div></div>';
    detailHtml += '<div style="padding-left:160px;font-size:12px;color:#71717a">';
    detailHtml += '<span style="color:#818cf8;margin-right:12px">New: '+newCount+'</span>';
    detailHtml += '<span style="color:#4ade80;margin-right:12px">Msg1 Sent: '+sentCount+'</span>';
    detailHtml += '<span style="color:#d946ef">Replied: '+repliedCount+'</span>';
    detailHtml += '</div></div>';
  });
  container.innerHTML = html;
  detail.innerHTML = detailHtml;
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Session path: /root/.wa-session`);
  if (WEBHOOK_URL) console.log(`Webhook: ${WEBHOOK_URL}`);
  if (N8N_WEBHOOK_URL) console.log(`N8N Webhook: ${N8N_WEBHOOK_URL}`);
});

console.log(`[Scheduler] Warming starts Monday ${autoSender.WARMING_START}, auto-ticker handles 60s checks`);
