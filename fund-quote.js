'use strict';

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fundQuoteFromProfile(code, profile) {
  const normalizedCode = String(code || '');
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error('Invalid fund code');
  const points = Array.isArray(profile?.netWorth) ? profile.netWorth : [];
  const latest = points[points.length - 1];
  if (!latest || finiteNumber(latest.value) == null) throw new Error('Fund NAV is unavailable');
  const previous = points[points.length - 2];
  const price = finiteNumber(latest.value);
  const prevClose = finiteNumber(previous?.value);
  const dailyReturn = finiteNumber(latest.dailyReturn);
  const pct = dailyReturn ?? (prevClose && price != null ? (price / prevClose - 1) * 100 : null);
  const timestamp = finiteNumber(latest.timestamp);
  const date = timestamp == null ? null : new Date(timestamp);

  return {
    symbol:`fund${normalizedCode}`,
    code:normalizedCode,
    name:String(profile?.name || normalizedCode).trim().slice(0, 80) || normalizedCode,
    price,
    prevClose,
    open:null,
    chg:prevClose == null ? null : price - prevClose,
    pct,
    high:null,
    low:null,
    volume:null,
    amount:null,
    updatedAt:timestamp,
    navDate:date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '',
    securityType:'FUND',
  };
}

module.exports = { fundQuoteFromProfile };
