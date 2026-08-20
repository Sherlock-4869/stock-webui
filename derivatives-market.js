'use strict';

const CFFEX_PRODUCTS = {
  IF:{ name:'沪深300股指期货', shortName:'沪深300', spotSymbol:'s_sh000300' },
  IH:{ name:'上证50股指期货', shortName:'上证50', spotSymbol:'s_sh000016' },
  IC:{ name:'中证500股指期货', shortName:'中证500', spotSymbol:'s_sh000905' },
  IM:{ name:'中证1000股指期货', shortName:'中证1000', spotSymbol:'s_sh000852' },
};

const US_INDEX_FUTURES = {
  hf_ES:{ code:'ES', name:'E-mini 标普500', currency:'USD' },
  hf_NQ:{ code:'NQ', name:'E-mini 纳斯达克100', currency:'USD' },
  hf_YM:{ code:'YM', name:'E-mini 道琼斯', currency:'USD' },
};

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractSinaRows(text) {
  const rows = new Map();
  const pattern = /var\s+hq_str_([a-zA-Z0-9_]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) rows.set(match[1], match[2].split(','));
  return rows;
}

function parseSinaSpotIndexes(text) {
  const source = extractSinaRows(text);
  const result = {};
  Object.entries(CFFEX_PRODUCTS).forEach(([code, definition]) => {
    const fields = source.get(definition.spotSymbol);
    const price = finiteNumber(fields?.[1]);
    if (price == null) return;
    result[code] = {
      code, name:definition.shortName, price,
      change:finiteNumber(fields[2]), pct:finiteNumber(fields[3]),
    };
  });
  return result;
}

function normalizeCffexFuture(row, spot) {
  if (!row || !CFFEX_PRODUCTS[String(row.symbol || '').slice(0, 2)]) return null;
  const code = String(row.symbol).slice(0, 2);
  const definition = CFFEX_PRODUCTS[code];
  const price = finiteNumber(row.trade ?? row.close);
  const prevSettlement = finiteNumber(row.prevsettlement ?? row.presettlement);
  if (price == null) return null;
  const change = prevSettlement == null ? null : price - prevSettlement;
  const pct = change == null || !prevSettlement ? null : change / prevSettlement * 100;
  const spotPrice = finiteNumber(spot?.price);
  const basis = spotPrice == null ? null : price - spotPrice;
  return {
    code, symbol:String(row.symbol), name:definition.name, shortName:definition.shortName,
    price, change, pct, prevSettlement,
    open:finiteNumber(row.open), high:finiteNumber(row.high), low:finiteNumber(row.low),
    volume:finiteNumber(row.volume), openInterest:finiteNumber(row.position),
    bid:finiteNumber(row.bidprice1), ask:finiteNumber(row.askprice1),
    date:String(row.tradedate || ''), time:String(row.ticktime || ''),
    spotPrice, spotPct:finiteNumber(spot?.pct), basis,
    basisPct:basis == null || !spotPrice ? null : basis / spotPrice * 100,
  };
}

function parseSinaGlobalFutures(text) {
  const source = extractSinaRows(text);
  return Object.entries(US_INDEX_FUTURES).flatMap(([symbol, definition]) => {
    const fields = source.get(symbol);
    const price = finiteNumber(fields?.[0]);
    if (price == null) return [];
    const prevClose = finiteNumber(fields[7]);
    const change = prevClose == null ? null : price - prevClose;
    return [{
      ...definition, symbol, price, prevClose, change,
      pct:change == null || !prevClose ? null : change / prevClose * 100,
      bid:finiteNumber(fields[2]), ask:finiteNumber(fields[3]),
      high:finiteNumber(fields[4]), low:finiteNumber(fields[5]), open:finiteNumber(fields[8]),
      volume:finiteNumber(fields[9]), time:String(fields[6] || ''), date:String(fields[12] || ''),
    }];
  });
}

function decodeHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFuturesFlashHtml(text, limit = 16) {
  const result = [];
  const links = String(text || '').match(/<a\b[\s\S]*?<\/a>/gi) || [];
  for (const link of links) {
    const href = link.match(/href="(https:\/\/qhweb\.eastmoney\.com\/news\/\d+\.html)"/i)?.[1];
    const time = decodeHtmlText(link.match(/<div\s+class="time">([\s\S]*?)<\/div>/i)?.[1]);
    const title = decodeHtmlText(link.match(/<div\s+class="title">([\s\S]*?)<\/div>/i)?.[1]);
    if (!href || !title) continue;
    result.push({ title, time, url:href, important:/class="[^"]*\bred\b/i.test(link) });
    if (result.length >= limit) break;
  }
  return result;
}

function safeEastmoneyUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !/(^|\.)eastmoney\.com$/i.test(url.hostname)) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

function parseEastmoneyFastNews(text, { limit = 16, keywords = [] } = {}) {
  const source = String(text || '').replace(/^\s*var\s+ajaxResult\s*=\s*/, '').replace(/;\s*$/, '');
  let payload;
  try { payload = JSON.parse(source); } catch (_) { return []; }
  const rows = Array.isArray(payload?.LivesList) ? payload.LivesList : [];
  const normalized = rows.flatMap(row => {
    const url = safeEastmoneyUrl(row.url_m || String(row.url_w || '').replace(/^http:/, 'https:'));
    const title = String(row.title || row.simtitle || '').trim();
    if (!title || !url) return [];
    return [{
      title, digest:String(row.digest || row.simdigest || '').trim(),
      time:String(row.showtime || row.ordertime || ''), url,
    }];
  });
  if (!keywords.length) return normalized.slice(0, limit);
  const matched = normalized.filter(row => keywords.some(keyword => `${row.title} ${row.digest}`.toLowerCase().includes(keyword.toLowerCase())));
  return matched.slice(0, limit);
}

module.exports = {
  CFFEX_PRODUCTS,
  US_INDEX_FUTURES,
  extractSinaRows,
  normalizeCffexFuture,
  parseEastmoneyFastNews,
  parseFuturesFlashHtml,
  parseSinaGlobalFutures,
  parseSinaSpotIndexes,
};
