const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { scrapeGoogleMaps } = require('./scraper');

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
