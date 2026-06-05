const { google } = require('googleapis');

function getServiceAccountJSON() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString()); }
}

async function getClient(scopes) {
  const sa = getServiceAccountJSON();
  return new google.auth.JWT(sa.client_email, null, sa.private_key, scopes);
}

async function getSheetData(sheetId, range) {
  const auth = await getClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range || 'Sheet1',
  });
  return res.data.values || [];
}

async function appendRows(sheetId, rows) {
  const auth = await getClient(['https://www.googleapis.com/auth/spreadsheets']);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function writeRange(sheetId, range, values) {
  const auth = await getClient(['https://www.googleapis.com/auth/spreadsheets']);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function getSheetInfo(sheetId) {
  const auth = await getClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return res.data;
}

module.exports = { getSheetData, appendRows, writeRange, getSheetInfo };