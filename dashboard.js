const { google } = require('googleapis');

let sheetsClient = null;

function getServiceAccountJSON() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var');
  // Handle both plain JSON and base64-encoded JSON
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString()); }
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const sa = getServiceAccountJSON();
  const auth = new google.auth.JWT(
    sa.client_email, null, sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function getSheetData(sheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range || 'Sheet1',
  });
  return res.data.values || [];
}

module.exports = { getSheetData };
