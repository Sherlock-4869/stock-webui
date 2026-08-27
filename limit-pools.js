'use strict';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function limitPoolSymbol(code, market) {
  if (!/^\d{6}$/.test(code)) return '';
  if (Number(market) === 1) return `sh${code}`;
  if (Number(market) === 0 && !/^[48]/.test(code)) return `sz${code}`;
  return '';
}

function normalizeLimitPoolRow(row, side) {
  const code = String(row?.c || '');
  const continuous = side === 'up' ? numberOrNull(row?.zttj?.ct ?? row?.lbc) : numberOrNull(row?.days);
  return {
    code,
    symbol:limitPoolSymbol(code, row?.m),
    name:String(row?.n || ''),
    price:numberOrNull(row?.p) == null ? null : Number(row.p) / 1000,
    pct:numberOrNull(row?.zdp),
    amount:numberOrNull(row?.amount),
    floatMarketCap:numberOrNull(row?.ltsz),
    marketCap:numberOrNull(row?.tshare),
    turnover:numberOrNull(row?.hs),
    sealAmount:numberOrNull(row?.fund),
    firstSealTime:numberOrNull(row?.fbt),
    lastSealTime:numberOrNull(row?.lbt),
    boardAmount:numberOrNull(row?.fba),
    continuousCount:continuous,
    openCount:numberOrNull(side === 'up' ? row?.zbc : row?.oc),
    industry:String(row?.hybk || ''),
  };
}

function normalizeLimitPoolPayload(payload, side, date) {
  const data = payload?.data;
  const rows = Array.isArray(data?.pool) ? data.pool : [];
  return {
    side,
    date:String(data?.qdate || date || ''),
    total:numberOrNull(data?.tc) ?? rows.length,
    data:rows.map(row => normalizeLimitPoolRow(row, side)).filter(row => row.code && row.name),
  };
}

module.exports = { normalizeLimitPoolPayload, normalizeLimitPoolRow };
