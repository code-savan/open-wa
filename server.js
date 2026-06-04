const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Session path: /root/.wa-session`);
  if (WEBHOOK_URL) console.log(`Webhook: ${WEBHOOK_URL}`);
});
