'use strict';

function normalizeSecuritySearchQuery(value) {
  const query = String(value || '').trim();
  return /[\u3400-\u9fff]/u.test(query) ? query.replace(/\s+/g, '') : query;
}

function isTencentEtfType(value) {
  return /(?:^|-)ETF(?:-|$)/i.test(String(value || ''));
}

function isTencentStockType(value) {
  return /^GP(?:-|$)/i.test(String(value || ''));
}

function decodeTencentName(value) {
  const rawName = String(value || '');
  try { return JSON.parse(`"${rawName.replace(/"/g, '\\"')}"`); }
  catch (_) { return rawName; }
}

function parseTencentSecuritySearch(source) {
  const match = String(source || '').match(/v_hint="([^"]*)"/);
  if (!match?.[1]) return [];
  const results = [];
  for (const item of match[1].split('^')) {
    const parts = item.split('~');
    if (parts.length < 3) continue;
    const [market, code, rawName, , type] = parts;
    const isEtf = isTencentEtfType(type);
    if (type && !isEtf && !isTencentStockType(type)) continue;
    const normalizedMarket = String(market || '').toLowerCase();
    if (!['sh', 'sz', 'hk', 'us'].includes(normalizedMarket)) continue;
    const normalizedCode = normalizedMarket === 'us'
      ? String(code || '').replace(/\.[A-Z]+$/i, '').toUpperCase()
      : String(code || '').toUpperCase();
    if (!/^[A-Z0-9._-]{1,24}$/i.test(normalizedCode)) continue;
    results.push({
      sym:`${normalizedMarket}${normalizedCode}`,
      name:decodeTencentName(rawName),
      market:normalizedMarket.toUpperCase(),
      code:normalizedCode,
      securityType:isEtf ? 'ETF' : 'STOCK',
    });
  }
  return results;
}

module.exports = {
  isTencentEtfType,
  normalizeSecuritySearchQuery,
  parseTencentSecuritySearch,
};
