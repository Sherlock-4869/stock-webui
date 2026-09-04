'use strict';

// Tencent quote fields place five bid levels at 9..18 and five ask levels at
// 19..28 (price/volume pairs).  Keeping this parser independent from the HTTP
// server makes the mapping easy to test and allows the browser to consume a
// stable, provider-neutral shape.
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseLevels(fields, start) {
  return Array.from({ length:5 }, (_, index) => ({
    level:index + 1,
    price:finiteNumber(fields[start + index * 2]),
    volume:finiteNumber(fields[start + index * 2 + 1]),
  })).filter(item => item.price != null || item.volume != null);
}

function classifySignal({ pct, imbalance, spread }) {
  const change = finiteNumber(pct);
  const ratio = finiteNumber(imbalance);
  if (ratio != null && ratio >= 1.8) return { type:'buy', label:'买盘占优', reason:'买一至买五挂单量显著高于卖盘' };
  if (ratio != null && ratio <= 0.56) return { type:'sell', label:'卖盘占优', reason:'卖一至卖五挂单量显著高于买盘' };
  if (change != null && change >= 3 && spread != null && spread <= 0.01) {
    return { type:'buy', label:'强势上行', reason:'涨幅较大且买卖价差较窄' };
  }
  if (change != null && change <= -3 && spread != null && spread <= 0.01) {
    return { type:'sell', label:'弱势下行', reason:'跌幅较大且买卖价差较窄' };
  }
  return { type:'neutral', label:'盘口均衡', reason:'买卖挂单力量接近' };
}

function parseTencentOrderBook(symbol, payload) {
  const marker = `v_${String(symbol)}="`;
  const line = String(payload || '').split(/\r?\n/).map(value => value.trim())
    .find(value => value.startsWith(marker));
  if (!line) return null;
  const end = line.indexOf('"', marker.length);
  if (end < 0) return null;
  const fields = line.slice(marker.length, end).split('~');
  const bids = parseLevels(fields, 9);
  const asks = parseLevels(fields, 19);
  const price = finiteNumber(fields[3]);
  const prevClose = finiteNumber(fields[4]);
  const change = finiteNumber(fields[31]);
  const pct = finiteNumber(fields[32]);
  const bidVolume = bids.reduce((sum, item) => sum + (item.volume || 0), 0);
  const askVolume = asks.reduce((sum, item) => sum + (item.volume || 0), 0);
  const imbalance = askVolume > 0 ? bidVolume / askVolume : bidVolume > 0 ? null : 1;
  const bestBid = bids.find(item => item.price != null)?.price ?? null;
  const bestAsk = asks.find(item => item.price != null)?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  return {
    symbol,
    name:fields[1] || symbol,
    code:fields[2] || symbol.replace(/^(?:sh|sz)/i, ''),
    price, prevClose, change, pct,
    bids, asks,
    totals:{ bidVolume, askVolume },
    imbalance,
    spread,
    signal:classifySignal({ pct, imbalance, spread }),
    updated:fields[30] || '',
  };
}

module.exports = { parseTencentOrderBook, classifySignal };
