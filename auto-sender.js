const { getSheetData, writeRange, getSheetInfo } = require('./sheet-utils');
const { parsePhones } = require('./phone-utils');
const fs = require('fs');
const path = require('path');

const STATE_FILE = '/tmp/auto_state.json';

let state = loadState();
let isRunning = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { date: '', sent: 0, total: 0, completed: false, current: null };
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
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
        sheet: title,
        row: r,
        business_name: name,
        phone: rawPhone,
        phones,
        niche: nicheIdx >= 0 ? (rows[r][nicheIdx] || '').trim() : '',
        location: locationIdx >= 0 ? (rows[r][locationIdx] || '').trim() : '',
        statusIdx,
        nameIdx,
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
    console.log(`[Auto] Failed to mark ${lead.business_name}: ${e.message}`);
  }
}

async function runBatch(client, leads, maxSends, onProgress) {
  const sent = [];
  const failed = [];
  let count = 0;
  for (const lead of leads) {
    if (count >= maxSends) break;
    state.current = lead.business_name;
    saveState();

    let sentOne = false;
    for (const phone of lead.phones) {
      try {
        const waId = `${phone}@c.us`;
        const msg = `Hey! 👋 I came across ${lead.business_name} on Google Maps. Really nice to see what you guys are doing.`;
        await client.sendMessage(waId, msg);
        if (!sentOne) {
          sentOne = true;
          count++;
        }
        sent.push({ name: lead.business_name, phone });
        console.log(`[Auto] Sent to ${lead.business_name} (${phone})`);
      } catch (e) {
        console.log(`[Auto] Failed ${lead.business_name} (${phone}): ${e.message}`);
      }
    }
    if (sentOne) {
      await markLead(client, lead, 'msg1_sent');
      state.sent++;
    } else {
      await markLead(client, lead, 'invalid');
      failed.push(lead.business_name);
    }

    if (onProgress) onProgress({ sent: state.sent, total: state.total, current: lead.business_name });
    if (count >= maxSends) break;

    // Random delay 3-6 minutes between sends
    const delayMs = randomDelay(180, 360);
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { sent, failed };
}

async function startAutomation(client, totalTarget = 50) {
  if (isRunning) return { error: 'Automation already running' };
  if (!client) return { error: 'WhatsApp not ready' };

  isRunning = true;
  const today = getToday();
  state.date = today;
  state.completed = false;
  state.sent = 0;
  state.total = totalTarget;
  state.current = 'starting...';
  saveState();

  try {
    const sheetId = process.env.SHEET_ID || '1TkWu6TTLaImjFliOKOPS0AYznmf45TWEJSeEfNORguc';
    const allLeads = await collectUnprocessedLeads(sheetId);
    if (!allLeads.length) {
      state.completed = true;
      state.current = 'no leads found';
      saveState();
      isRunning = false;
      return { error: 'No unprocessed leads found' };
    }

    // Group by sheet to ensure even distribution
    const bySheet = {};
    for (const lead of allLeads) {
      if (!bySheet[lead.sheet]) bySheet[lead.sheet] = [];
      bySheet[lead.sheet].push(lead);
    }

    const sheetNames = Object.keys(bySheet);
    const perSheet = Math.floor(totalTarget / sheetNames.length);
    const remainder = totalTarget % sheetNames.length;

    // Take evenly from each sheet, shuffle together
    const batch = [];
    for (const name of sheetNames) {
      const take = perSheet + (remainder > 0 && sheetNames.indexOf(name) < remainder ? 1 : 0);
      const shuffled = bySheet[name].sort(() => Math.random() - 0.5);
      batch.push(...shuffled.slice(0, take));
    }
    // Final shuffle across niches
    batch.sort(() => Math.random() - 0.5);

    const result = await runBatch(client, batch, totalTarget, (p) => {
      saveState();
    });

    state.completed = true;
    state.current = 'completed';
    saveState();
    isRunning = false;
    return { success: true, sent: result.sent.length, failed: result.failed.length };
  } catch (e) {
    state.completed = true;
    state.current = `error: ${e.message}`;
    saveState();
    isRunning = false;
    return { error: e.message };
  }
}

function getStatus() {
  const today = getToday();
  if (state.date !== today) {
    return { date: today, sent: 0, total: 0, completed: false, running: isRunning, current: 'waiting for schedule' };
  }
  return {
    date: state.date,
    sent: state.sent,
    total: state.total,
    completed: state.completed,
    running: isRunning,
    current: state.current,
  };
}

module.exports = { startAutomation, getStatus };
