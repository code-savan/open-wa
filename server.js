const { create } = require('@open-wa/wa-automate');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SESSION_DIR = '/root/.wa-session';

let client = null;

async function start() {
  client = await create({
    sessionId: 'morrnaire',
    sessionDataPath: SESSION_DIR,
    cacheEnabled: false,
    headless: true,
    logConsoleErrors: true,
  });

  if (WEBHOOK_URL) {
    client.onMessage(async (message) => {
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: message.from,
            body: message.body,
            senderName: message.sender ? message.sender.name || message.sender.pushname : '',
            timestamp: message.timestamp,
          }),
        });
      } catch (err) {
        console.error('Webhook call failed:', err.message);
      }
    });
  }

  app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }
    try {
      const formatted = phone.includes('@c.us') ? phone : `${phone}@c.us`;
      await client.sendText(formatted, message);
      res.json({ success: true, to: phone });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ status: client ? 'connected' : 'starting' });
  });

  app.listen(PORT, () => {
    console.log(`open-wa server running on port ${PORT}`);
    console.log(`Session path: ${SESSION_DIR}`);
    if (WEBHOOK_URL) console.log(`Webhook: ${WEBHOOK_URL}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
