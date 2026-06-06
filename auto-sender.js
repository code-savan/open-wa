const { getSheetData, writeRange, getSheetInfo } = require('./sheet-utils');
const { parsePhones } = require('./phone-utils');
const fs = require('fs');

const STATE_FILE = '/tmp/auto_state.json';
const WARMING_START = '2026-06-08'; // Monday

const MSG_TEMPLATES = [
  (name) => `Hey! 👋 I came across ${name} on Google Maps. Really nice to see what you guys are doing.`,
  (name) => `Hi there! 👋 Stumbled on ${name} while searching online — love what you've got going on. Quick question for you...`,
  (name) => `Hello! 👋 I was checking out businesses around and ${name} caught my eye. Mind if I ask you something?`,
  (name) => `Hey! 👋 Found ${name} while browsing — you guys look solid. Got a quick one for you...`,
];

const WEEK_CONFIGS = [
  { week: 1, dailyCap: 10, batchSize: 3, gapMin: 15, gapMax: 30, cooldownMin: 30, cooldownMax: 60, startHour: 10, endHour: 14 },
  { week: 2, dailyCap: 20, batchSize: 5, gapMin: 10, gapMax: 15, cooldownMin: 30, cooldownMax: 45, startHour: 10, endHour: 15 },
  { week: 3, dailyCap: 35, batchSize: 8, gapMin: 5, gapMax: 10, cooldownMin: 20, cooldownMax: 30, startHour: 9, endHour: 15 },
  { week: 4, dailyCap: 50, batchSize: 12, gapMin: 3, gapMax: 5, cooldownMin: 10, cooldownMax: 20, startHour: 9, endHour: 15 },
  { week: 5, dailyCap: 75, batchSize: 15, gapMin: 2, gapMax: 4, cooldownMin: 5, cooldownMax: 15, startHour: 9, endHour: 15 },
];

let state = loadState();
let isRunning = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return {
    date: '',
    sent: 0,
    cap: 0,
    week: 1,
    completed: false,
    current: null,
    batchSentToday: 0,
    nextAction: null,
    lastSend: null,
    started: false,
  };
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

function lagosNow() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  return { hour: (utcH + 1) % 24, minute: utcM, iso: now.toISOString(), day: now.getUTCDay() };
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getWeeksSince(start) {
  const s = new Date(start);
  const now = new Date();
  const diff = (now - s) / (7 * 24 * 60 * 60 * 1000);
  return Math.max(1, Math.floor(diff) + 1);
}

function getWeekConfig() {
  const weekNum = getWeeksSince(WARMING_START);
  const idx = Math.min(weekNum - 1, WEEK_CONFIGS.length - 1);
  return { ...WEEK_CONFIGS[idx], week: weekNum };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMsg(name) {
  return MSG_TEMPLATES[randomInt(0, MSG_TEMPLATES.length - 1)](name);
}

async function collectUnprocessedLeads(sheetId) {
  const info = await getSheetInfo(sheetId);
  const all = [];
  for (const s of (info.sheets || [])) {
    const title = s.properties.title;
    const maxRow = Math.min(s.properties.gridProperties.rowCount, 1000);
    if (maxRow < 2) continue;
    const rows = await getSheetData(sheetId, `${title}!A1:Z${maxRow}`);
    if (rows.length < 2) continue;
    const headers = rows[0];
    const nameIdx = headers.findIndex(h => /name/i.test(h));
    const phoneIdx = headers.findIndex(h => /phone|tel|mobile|number|whatsapp/i.test(h));
    const nicheIdx = headers.findIndex(h => /niche|category|type|service|industry/i.test(h));
    const locationIdx = headers.findIndex(h => /location|city|town|address/i.test(h));
    const statusIdx = headers.findIndex(h => /status/i.test(h));
    if (nameIdx < 0 || phoneIdx < 0) continue;
    for (let r = 1; r < rows.length; r++) {
      const status = statusIdx >= 0 ? (rows[r][statusIdx] || '').trim().toLowerCase() : '';
      if (status === 'msg1_sent' || status === 'invalid' || status === 'msg2_sent') continue;
      const name = (rows[r][nameIdx] || '').trim();
      const rawPhone = (rows[r][phoneIdx] || '').trim();
      if (!name || !rawPhone) continue;
      const phones = parsePhones(rawPhone);
      if (!phones.length) continue;
      all.push({
        sheet: title, row: r, business_name: name,
        phone: rawPhone, phones,
        niche: nicheIdx >= 0 ? (rows[r][nicheIdx] || '').trim() : '',
        location: locationIdx >= 0 ? (rows[r][locationIdx] || '').trim() : '',
        statusIdx,
      });
    }
  }
  return all;
}

async function markLead(client, lead, status) {
  if (lead.statusIdx < 0) return;
  try {
    const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const col = String.fromCharCode(65 + lead.statusIdx);
    await writeRange(sheetId, `${lead.sheet}!${col}${lead.row + 1}`, [[status]]);
  } catch (e) {
    console.log(`[Auto] Mark failed for ${lead.business_name}: ${e.message}`);
  }
}

async function sendBatch(client, leads, config) {
  const sent = [];
  const failed = [];
  let batchCount = 0;

  for (const lead of leads) {
    if (batchCount >= config.batchSize) break;

    state.current = lead.business_name;
    state.lastSend = Date.now();
    saveState();

    let sentOne = false;
    for (const phone of lead.phones) {
      try {
        const waId = `${phone}@c.us`;
        const msg = randomMsg(lead.business_name);
        await client.sendMessage(waId, msg);
        if (!sentOne) {
          sentOne = true;
          batchCount++;
          state.sent++;
          state.batchSentToday++;
        }
        console.log(`[Auto] ✓ ${lead.business_name} (${phone})`);
      } catch (e) {
        console.log(`[Auto] ✗ ${lead.business_name} (${phone}): ${e.message.slice(0, 60)}`);
      }
    }
    if (sentOne) {
      await markLead(client, lead, 'msg1_sent');
      sent.push(lead.business_name);
    } else {
      await markLead(client, lead, 'invalid');
      failed.push(lead.business_name);
    }

    // Gap within batch
    if (batchCount < config.batchSize && batchCount < leads.length) {
      const gapMs = randomInt(config.gapMin, config.gapMax) * 60 * 1000;
      state.nextAction = new Date(Date.now() + gapMs).toISOString();
      saveState();
      await new Promise(r => setTimeout(r, gapMs));
    }
  }

  return { sent, failed, batchCount };
}

function isWithinWindow(hour, config) {
  return hour >= config.startHour && hour < config.endHour;
}

async function tick(client) {
  if (!client) return { action: 'no_client' };

  const now = lagosNow();

  // Weekend check (day 0 = Sunday, 6 = Saturday)
  if (now.day === 0 || now.day === 6) {
    state.current = 'weekend — no sends';
    saveState();
    return { action: 'weekend' };
  }

  const config = getWeekConfig();
  const today = getToday();

  // Reset daily state if new day
  if (state.date !== today) {
    state.date = today;
    state.sent = 0;
    state.completed = false;
    state.batchSentToday = 0;
    state.cap = config.dailyCap;
    state.week = config.week;
    state.nextAction = null;
    state.lastSend = null;
    state.current = 'idle';
    saveState();
  }

  // Already done for today
  if (state.completed) return { action: 'completed', sent: state.sent, cap: state.cap };

  // Outside window
  if (!isWithinWindow(now.hour, config)) {
    state.current = `outside window (${config.startHour}:00-${config.endHour}:00)`;
    saveState();
    return { action: 'outside_window' };
  }

  // In cooldown?
  if (state.nextAction && Date.now() < new Date(state.nextAction).getTime()) {
    const remaining = Math.round((new Date(state.nextAction) - Date.now()) / 1000 / 60);
    state.current = `cooldown ${remaining}m remaining`;
    saveState();
    return { action: 'cooldown', remaining };
  }

  // Cap reached?
  if (state.sent >= config.dailyCap) {
    state.completed = true;
    state.current = 'completed';
    saveState();
    return { action: 'completed', sent: state.sent, cap: config.dailyCap };
  }

  // Collect leads
  const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
  const allLeads = await collectUnprocessedLeads(sheetId);
  if (!allLeads.length) {
    state.current = 'no unprocessed leads';
    saveState();
    return { action: 'no_leads' };
  }

  // Shuffle for cross-niche randomness
  allLeads.sort(() => Math.random() - 0.5);

  const remaining = config.dailyCap - state.sent;
  const batchSize = Math.min(config.batchSize, remaining, allLeads.length);

  state.current = `sending batch (${batchSize} msgs)`;
  saveState();

  const result = await sendBatch(client, allLeads.slice(0, batchSize), config);

  // Schedule next action (cooldown between batches)
  const cooldownMs = randomInt(config.cooldownMin, config.cooldownMax) * 60 * 1000;
  state.nextAction = new Date(Date.now() + cooldownMs).toISOString();
  state.current = `batch done, cooldown ${Math.round(cooldownMs/1000/60)}m`;
  saveState();

  if (state.sent >= config.dailyCap) {
    state.completed = true;
    state.current = 'completed';
    saveState();
  }

  return {
    action: 'batch_sent',
    sent: result.sent.length,
    failed: result.failed.length,
    totalSent: state.sent,
    cap: config.dailyCap,
    nextAction: state.nextAction,
  };
}

async function startAutomation(client) {
  if (isRunning) return { error: 'Already running' };
  isRunning = true;
  const result = await tick(client);
  isRunning = false;
  return result;
}

function getStatus() {
  const now = lagosNow();
  const today = getToday();
  const config = getWeekConfig();
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.day];

  // Calculate week info
  const weekNum = getWeeksSince(WARMING_START);
  const maxWeek = WEEK_CONFIGS.length;
  const currentWeekCfg = getWeekConfig();

  // Determine overall phase
  let phase = 'warming';
  if (weekNum >= maxWeek) phase = 'active';
  if (now.day === 0 || now.day === 6) phase = 'weekend';

  // Status for today
  let sendStatus = 'idle';
  if (state.completed) sendStatus = 'completed';
  else if (state.current && state.current.includes('sending')) sendStatus = 'sending';
  else if (state.current && state.current.includes('cooldown')) sendStatus = 'cooldown';
  else if (state.current && state.current.includes('weekend')) sendStatus = 'weekend';
  else if (state.current && state.current.includes('window')) sendStatus = 'outside_window';
  else if (state.current && state.current.includes('no leads')) sendStatus = 'no_leads';

  return {
    date: today,
    day: dayName,
    phase,
    warmingWeek: weekNum,
    maxWarmingWeek: maxWeek,
    dailyCap: currentWeekCfg.dailyCap,
    window: `${currentWeekCfg.startHour}:00-${currentWeekCfg.endHour}:00`,
    batchSize: currentWeekCfg.batchSize,
    gapRange: `${currentWeekCfg.gapMin}-${currentWeekCfg.gapMax} min`,
    cooldownRange: `${currentWeekCfg.cooldownMin}-${currentWeekCfg.cooldownMax} min`,

    sent: state.date === today ? state.sent : 0,
    completed: state.date === today ? state.completed : false,
    current: state.current || 'idle',
    sendStatus,
    nextAction: state.nextAction,
    lastSend: state.lastSend,
    remaining: state.date === today ? Math.max(0, currentWeekCfg.dailyCap - state.sent) : currentWeekCfg.dailyCap,
  };
}

function resetState() {
  state = {
    date: '', sent: 0, cap: 0, week: 1,
    completed: false, current: null,
    batchSentToday: 0, nextAction: null,
    lastSend: null, started: false,
  };
  saveState();
}

// Start the periodic ticker (checks every minute)
let tickInterval = null;
function startTicker(client) {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try { await tick(client); } catch (e) { console.log('[Auto] Tick error:', e.message); }
    isRunning = false;
  }, 60000);
  console.log('[Auto] Ticker started (checks every 60s)');
}

module.exports = { startAutomation, getStatus, resetState, startTicker, WARMING_START };
