'use strict';

// The mainstream quote-app convention is the total breadth of listed A shares
// on Shanghai, Shenzhen and Beijing, with suspended stocks left out because
// they have no valid intraday percentage change.
const MAINLAND_MARKET_BREADTH_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const MAINLAND_MARKET_BREADTH_CODES = Object.freeze(['000001', '399106']);

function summarizeMarketBreadth(rows) {
  const result = {
    rising:0, falling:0, flat:0, quoted:0,
    trading:{ volume:0, amount:0, totalMarketCap:0, floatMarketCap:0 },
  };
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const pct = Number(row?.f3);
    if (!Number.isFinite(pct)) return;
    result.quoted += 1;
    if (pct > 0) result.rising += 1;
    else if (pct < 0) result.falling += 1;
    else result.flat += 1;
    [['f5','volume'], ['f6','amount'], ['f20','totalMarketCap'], ['f21','floatMarketCap']].forEach(([field, key]) => {
      const value = Number(row?.[field]);
      if (Number.isFinite(value)) result.trading[key] += value;
    });
  });
  return result;
}

module.exports = { MAINLAND_MARKET_BREADTH_CODES, MAINLAND_MARKET_BREADTH_FS, summarizeMarketBreadth };
