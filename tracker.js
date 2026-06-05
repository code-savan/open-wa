const fs = require('fs');
const path = require('path');

const LOG_FILE = '/tmp/automation_log.json';
const MAX_EVENTS = 500;

let events = [];

function load() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      events = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
  } catch {}
}

function save() {
  try {
    const data = events.slice(-MAX_EVENTS);
    fs.writeFileSync(LOG_FILE, JSON.stringify(data), 'utf8');
  } catch {}
}

function add(type, data = {}) {
  events.push({
    type,
    time: new Date().toISOString(),
    ...data,
  });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  save();
}

function getAll(limit = 100) {
  return events.slice(-limit).reverse();
}

function getStats() {
  const stats = {
    total_scrapes: 0,
    total_leads_found: 0,
    total_messages_sent: 0,
    total_messages_replied: 0,
    total_errors: 0,
    last_scrape: null,
    last_message: null,
  };
  for (const e of events) {
    if (e.type === 'scrape_done') {
      stats.total_scrapes++;
      stats.total_leads_found += e.count || 0;
      stats.last_scrape = e.time;
    } else if (e.type === 'message_sent') {
      stats.total_messages_sent++;
      stats.last_message = e.time;
    } else if (e.type === 'message_replied') {
      stats.total_messages_replied++;
    } else if (e.type === 'error') {
      stats.total_errors++;
    }
  }
  return stats;
}

load();

module.exports = { add, getAll, getStats };
