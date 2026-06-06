function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw);
  s = s.replace(/[,.\-\s()/+]/g, '');
  s = s.replace(/\.00$/, '');
  s = s.replace(/[^0-9]/g, '');
  if (!s || s.length < 10) return null;

  if (s.length === 13 && s.startsWith('234')) return s;
  if (s.length === 14 && s.startsWith('234')) return '234' + s.slice(4);
  if (s.length === 11 && s.startsWith('0')) return '234' + s.slice(1);
  if (s.length === 10) return '234' + s;
  if (s.startsWith('234') && s.length > 13) return s.slice(0, 13);
  return '234' + s;
}

function parsePhones(raw) {
  if (!raw) return [];
  const seen = new Set();
  const parts = String(raw).split(/[,;\n]+/);
  for (const part of parts) {
    const n = normalizePhone(part.trim());
    if (n && !seen.has(n)) seen.add(n);
  }
  return [...seen];
}

module.exports = { normalizePhone, parsePhones };
