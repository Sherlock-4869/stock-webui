'use strict';

const TROY_OUNCE_GRAMS = 31.1034768;
const PRECIOUS_METAL_HISTORY_RANGES = { '1m':22, '3m':66, '6m':130, '1y':260, '3y':780 };

// kind: global = Sina hf_ international quotes, inner = Sina nf_ SHFE continuous
// futures, sge = Sina gds_ Shanghai Gold Exchange spot contracts.
const PRECIOUS_METAL_INSTRUMENTS = [
  { id:'XAU', symbol:'hf_XAU', kind:'global', market:'international', metal:'gold', name:'伦敦金', subtitle:'国际现货黄金', unit:'美元/盎司', currency:'USD', digits:2, history:'XAU' },
  { id:'GC', symbol:'hf_GC', kind:'global', market:'international', metal:'gold', name:'COMEX 黄金', subtitle:'纽约期金连续', unit:'美元/盎司', currency:'USD', digits:2, history:'GC' },
  { id:'XAG', symbol:'hf_XAG', kind:'global', market:'international', metal:'silver', name:'伦敦银', subtitle:'国际现货白银', unit:'美元/盎司', currency:'USD', digits:3, history:'XAG' },
  { id:'SI', symbol:'hf_SI', kind:'global', market:'international', metal:'silver', name:'COMEX 白银', subtitle:'纽约期银连续', unit:'美元/盎司', currency:'USD', digits:3, history:'SI' },
  { id:'XPT', symbol:'hf_XPT', kind:'global', market:'international', metal:'platinum', name:'NYMEX 铂金', subtitle:'纽约铂金连续', unit:'美元/盎司', currency:'USD', digits:2, history:'XPT' },
  { id:'XPD', symbol:'hf_XPD', kind:'global', market:'international', metal:'palladium', name:'NYMEX 钯金', subtitle:'纽约钯金连续', unit:'美元/盎司', currency:'USD', digits:2, history:'XPD' },
  { id:'AU0', symbol:'nf_AU0', kind:'inner', market:'domestic', metal:'gold', name:'沪金主连', subtitle:'上期所黄金连续', unit:'元/克', currency:'CNY', digits:2, history:'AU0' },
  { id:'AG0', symbol:'nf_AG0', kind:'inner', market:'domestic', metal:'silver', name:'沪银主连', subtitle:'上期所白银连续', unit:'元/千克', currency:'CNY', digits:0, history:'AG0' },
  { id:'AU9999', symbol:'gds_AU9999', kind:'sge', market:'domestic', metal:'gold', name:'上海金 Au99.99', subtitle:'上金所现货', unit:'元/克', currency:'CNY', digits:2, history:'' },
  { id:'AUTD', symbol:'gds_AUTD', kind:'sge', market:'domestic', metal:'gold', name:'黄金 T+D', subtitle:'上金所延期', unit:'元/克', currency:'CNY', digits:2, history:'' },
  { id:'AGTD', symbol:'gds_AGTD', kind:'sge', market:'domestic', metal:'silver', name:'白银 T+D', subtitle:'上金所延期', unit:'元/千克', currency:'CNY', digits:0, history:'' },
];

const PRECIOUS_METAL_MACRO = [
  { id:'USDCNY', symbol:'fx_susdcny', kind:'fx', name:'在岸人民币', unit:'CNY/USD', digits:4 },
  { id:'DXY', symbol:'DINIW', kind:'index', name:'美元指数', unit:'', digits:3 },
];

const INSTRUMENT_BY_ID = new Map(PRECIOUS_METAL_INSTRUMENTS.map(item => [item.id, item]));

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function extractSinaRows(text) {
  const rows = new Map();
  const pattern = /(?:var\s+)?hq_str_([a-zA-Z0-9_]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) rows.set(match[1], match[2] ? match[2].split(',') : []);
  return rows;
}

function sinaClock(value) {
  const text = String(value || '').trim();
  if (/^\d{6}$/.test(text)) return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`;
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) ? text : '';
}

function withChange(base) {
  const { price, prevClose, high, low } = base;
  const change = prevClose ? price - prevClose : null;
  const range = high != null && low != null && high > low ? high - low : null;
  return {
    ...base,
    change,
    pct:change == null ? null : change / prevClose * 100,
    amplitude:range == null || !prevClose ? null : range / prevClose * 100,
    rangePosition:range == null ? null : Math.max(0, Math.min(1, (price - low) / range)),
  };
}

function parseInstrumentFields(definition, fields) {
  if (!Array.isArray(fields) || !fields.length) return null;
  if (definition.kind === 'inner') {
    // name,time(hhmmss),open,high,low,?,bid,ask,last,settlement,prevSettlement,bidVol,askVol,openInterest,volume,exchange,product,date
    const price = positiveNumber(fields[8]);
    const prevClose = positiveNumber(fields[10]);
    if (price == null || prevClose == null) return null;
    return withChange({
      price, prevClose, open:positiveNumber(fields[2]), high:positiveNumber(fields[3]), low:positiveNumber(fields[4]),
      bid:positiveNumber(fields[6]), ask:positiveNumber(fields[7]), volume:finiteNumber(fields[14]),
      openInterest:finiteNumber(fields[13]), time:sinaClock(fields[1]), date:String(fields[17] || ''),
      prevLabel:'昨结算',
    });
  }
  // hf_/gds_: last,?,bid,ask,high,low,time,prevClose,open,volume,?,?,date,name
  const price = positiveNumber(fields[0]);
  const prevClose = positiveNumber(fields[7]);
  if (price == null || prevClose == null) return null;
  return withChange({
    price, prevClose, open:positiveNumber(fields[8]), high:positiveNumber(fields[4]), low:positiveNumber(fields[5]),
    bid:positiveNumber(fields[2]), ask:positiveNumber(fields[3]),
    volume:definition.kind === 'sge' ? finiteNumber(fields[9]) : null, openInterest:null,
    time:sinaClock(fields[6]), date:String(fields[12] || ''),
    prevLabel:definition.kind === 'sge' ? '昨收' : '昨收/结算',
  });
}

function parseMacroFields(definition, fields) {
  if (!Array.isArray(fields) || !fields.length) return null;
  if (definition.kind === 'fx') {
    // time,bid,ask,prevClose,spread,open,high,low,last,name,pct,change,amplitude,...,date
    const price = positiveNumber(fields[8]);
    const prevClose = positiveNumber(fields[3]);
    if (price == null || prevClose == null) return null;
    return withChange({ price, prevClose, open:positiveNumber(fields[5]), high:positiveNumber(fields[6]), low:positiveNumber(fields[7]), time:sinaClock(fields[0]), date:String(fields[17] || '') });
  }
  // DINIW: time,last,?,prevClose,?,open,high,low,last,name,date
  const price = positiveNumber(fields[1]) ?? positiveNumber(fields[8]);
  const prevClose = positiveNumber(fields[3]);
  if (price == null || prevClose == null) return null;
  return withChange({ price, prevClose, open:positiveNumber(fields[5]), high:positiveNumber(fields[6]), low:positiveNumber(fields[7]), time:sinaClock(fields[0]), date:String(fields[10] || '') });
}

function parsePreciousMetalQuotes(text) {
  const source = extractSinaRows(text);
  const quotes = PRECIOUS_METAL_INSTRUMENTS.flatMap(definition => {
    const quote = parseInstrumentFields(definition, source.get(definition.symbol));
    if (!quote) return [];
    const { symbol, kind, ...publicDefinition } = definition;
    return [{ ...publicDefinition, hasHistory:Boolean(definition.history), ...quote }];
  });
  const macro = PRECIOUS_METAL_MACRO.flatMap(definition => {
    const quote = parseMacroFields(definition, source.get(definition.symbol));
    if (!quote) return [];
    const { symbol, kind, ...publicDefinition } = definition;
    return [{ ...publicDefinition, ...quote }];
  });
  return { quotes, macro };
}

function spread(value, reference) {
  if (value == null || reference == null || !reference) return { value:null, pct:null };
  return { value:value - reference, pct:(value - reference) / reference * 100 };
}

function computePreciousMetalAnalytics(quotes, macro) {
  const price = id => (quotes.find(item => item.id === id) || macro.find(item => item.id === id))?.price ?? null;
  const usdCny = price('USDCNY');
  const xau = price('XAU'), xag = price('XAG');
  const londonGoldCny = xau != null && usdCny != null ? xau * usdCny / TROY_OUNCE_GRAMS : null;
  const londonSilverCny = xag != null && usdCny != null ? xag * usdCny / TROY_OUNCE_GRAMS * 1000 : null;
  const au0 = price('AU0'), ag0 = price('AG0');
  const goldPremium = spread(price('AU9999'), londonGoldCny);
  const silverPremium = spread(price('AGTD'), londonSilverCny);
  return {
    usdCny,
    londonGoldCny,
    londonSilverCny,
    goldSilverRatio:xau != null && xag ? xau / xag : null,
    domesticGoldSilverRatio:au0 != null && ag0 ? au0 / (ag0 / 1000) : null,
    goldPremium:goldPremium.value,
    goldPremiumPct:goldPremium.pct,
    silverPremium:silverPremium.value,
    silverPremiumPct:silverPremium.pct,
    comexLondonSpread:spread(price('GC'), xau).value,
    shfeSpotSpread:spread(au0, price('AU9999')).value,
    goldPlatinumRatio:xau != null && price('XPT') ? xau / price('XPT') : null,
  };
}

function parseSinaJsonp(text) {
  const source = String(text || '');
  const start = source.indexOf('(', source.indexOf('='));
  const end = source.lastIndexOf(')');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start + 1, end)); } catch (_) { return null; }
}

function parsePreciousMetalDaily(text, limit = 260) {
  const rows = parseSinaJsonp(text);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const date = String(row?.date ?? row?.d ?? '');
    const close = positiveNumber(row?.close ?? row?.c);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close == null) return [];
    return [{
      date, close,
      open:positiveNumber(row.open ?? row.o), high:positiveNumber(row.high ?? row.h), low:positiveNumber(row.low ?? row.l),
      volume:finiteNumber(row.volume ?? row.v),
    }];
  }).slice(-Math.max(1, limit));
}

function parsePreciousMetalMinute(text, kind) {
  const payload = parseSinaJsonp(text);
  const rows = kind === 'global' ? payload?.minLine_1d : payload;
  if (!Array.isArray(rows) || !rows.length) return { points:[], prevClose:null, date:'' };
  let prevClose = null, date = '';
  const points = rows.flatMap((row, index) => {
    if (!Array.isArray(row)) return [];
    let fields = row;
    if (kind === 'global' && index === 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(row[0]))) {
      // First international row: date,prevClose,exchange,'',time,price,volume,?,average,datetime
      date = String(row[0]); prevClose = positiveNumber(row[1]); fields = row.slice(4);
    } else if (kind !== 'global' && index === 0) {
      // First SHFE row: time,price,average,volume,openInterest,prevSettlement,date
      prevClose = positiveNumber(row[5]); date = String(row[6] || '');
    }
    const time = String(fields[0] || '');
    const value = positiveNumber(fields[1]);
    if (!/^\d{2}:\d{2}$/.test(time) || value == null) return [];
    const average = positiveNumber(kind === 'global' ? fields[4] : fields[2]);
    return [{ time, price:value, average }];
  });
  return { points, prevClose, date };
}

function preciousMetalHistoryRequest(id, range) {
  const definition = INSTRUMENT_BY_ID.get(String(id || ''));
  if (!definition?.history) return null;
  const normalizedRange = range === 'intraday' || PRECIOUS_METAL_HISTORY_RANGES[range] ? range : '';
  if (!normalizedRange) return null;
  const encoded = encodeURIComponent(definition.history);
  const service = definition.kind === 'global' ? 'GlobalFuturesService' : 'InnerFuturesNewService';
  const method = normalizedRange === 'intraday'
    ? (definition.kind === 'global' ? 'getGlobalFuturesMinLine' : 'getMinLine')
    : (definition.kind === 'global' ? 'getGlobalFuturesDailyKLine' : 'getDailyKLine');
  return {
    definition, range:normalizedRange,
    url:`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${encoded}=/${service}.${method}?symbol=${encoded}`,
    limit:PRECIOUS_METAL_HISTORY_RANGES[normalizedRange] || 0,
  };
}

module.exports = {
  PRECIOUS_METAL_HISTORY_RANGES,
  PRECIOUS_METAL_INSTRUMENTS,
  PRECIOUS_METAL_MACRO,
  TROY_OUNCE_GRAMS,
  computePreciousMetalAnalytics,
  extractSinaRows,
  parsePreciousMetalDaily,
  parsePreciousMetalMinute,
  parsePreciousMetalQuotes,
  parseSinaJsonp,
  preciousMetalHistoryRequest,
};
