'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRECIOUS_METAL_INSTRUMENTS,
  TROY_OUNCE_GRAMS,
  computePreciousMetalAnalytics,
  parsePreciousMetalDaily,
  parsePreciousMetalMinute,
  parsePreciousMetalQuotes,
  preciousMetalHistoryRequest,
} = require('../precious-metals');

const QUOTES = [
  'var hq_str_hf_XAU="3778.30,3849.170,3778.30,3778.65,3857.33,3775.92,14:51:00,3849.17,3852.93,0,0,0,2026-11-18,伦敦金（现货黄金）";',
  'var hq_str_hf_XAG="46.01,47.380,46.01,46.06,47.60,45.72,14:51:00,47.38,47.49,0,0,0,2026-11-18,伦敦银（现货白银）";',
  'var hq_str_hf_GC="3780.259,,3780.500,3780.900,3859.300,3777.500,14:51:40,3864.200,3855.200,0,1,1,2026-11-18,纽约黄金,0";',
  'var hq_str_hf_XPT="1402.141,,1402.800,1403.200,1431.700,1396.000,14:51:40,1426.500,1423.700,0,1,2,2026-11-18,纽约铂金,0";',
  'var hq_str_nf_AU0="黄金连续,145147,832.460,839.400,814.060,0.000,814.780,814.840,814.800,0.000,834.020,1,2,149333.000,138944,沪,黄金,2026-11-18,1";',
  'var hq_str_nf_AG0="白银连续,145147,11398.000,11490.000,10933.000,0.000,11020.000,11022.000,11022.000,0.000,11262.000,1,7,307851.000,1091545,沪,白银,2026-11-18,1";',
  'var hq_str_gds_AU9999="812.00,0,811.80,812.60,834.00,811.00,14:51:24,832.50,833.00,933304,135.00,97.00,2026-11-18,沪金99";',
  'var hq_str_gds_AGTD="10972.00,0,10971.00,10977.00,11443.00,10898.00,14:51:27,11345.00,11353.00,343412,30.00,165.00,2026-11-18,白银延期";',
  'var hq_str_hf_SI="";',
  'var hq_str_fx_susdcny="14:51:01,6.6661000000,6.6662000000,6.6663000000,36.0000000000,6.6667000000,6.6695000000,6.6659000000,6.6660000000,在岸人民币,-0.0045,-0.0003,0.0036,此行情由新浪财经计算得出,0.0000,0.0000,,2026-11-18";',
  'var hq_str_DINIW="14:51:46,103.7040,103.7040,103.5625,1787,103.5632,103.7157,103.5370,103.7040,美元指数,2026-11-18";',
].join('\n');

test('parses international, SHFE and SGE precious metal quote layouts', () => {
  const { quotes, macro } = parsePreciousMetalQuotes(QUOTES);
  const byId = Object.fromEntries(quotes.map(item => [item.id, item]));
  assert.equal(byId.XAU.price, 3778.3);
  assert.equal(byId.XAU.prevClose, 3849.17);
  assert.equal(byId.XAU.high, 3857.33);
  assert.equal(byId.XAU.time, '14:51:00');
  // SHFE nf_ rows start with the contract name; the last price is field 8.
  assert.equal(byId.AU0.price, 814.8);
  assert.equal(byId.AU0.prevClose, 834.02);
  assert.equal(byId.AU0.openInterest, 149333);
  assert.equal(byId.AU0.volume, 138944);
  assert.equal(byId.AU0.time, '14:51:47');
  assert.equal(byId.AU9999.price, 812);
  assert.equal(byId.AU9999.volume, 933304);
  assert.ok(Math.abs(byId.XAU.pct - (3778.3 - 3849.17) / 3849.17 * 100) < 1e-9);
  assert.ok(byId.XAU.rangePosition >= 0 && byId.XAU.rangePosition <= 1);
  assert.equal(byId.SI, undefined, 'empty upstream rows are skipped');
  assert.equal(byId.XAU.symbol, undefined, 'upstream symbols are not exposed');
  assert.equal(byId.AU9999.hasHistory, false);
  assert.equal(byId.AU0.hasHistory, true);
  const usd = macro.find(item => item.id === 'USDCNY');
  const dxy = macro.find(item => item.id === 'DXY');
  assert.equal(usd.price, 6.666);
  assert.equal(usd.prevClose, 6.6663);
  assert.equal(dxy.price, 103.704);
  assert.equal(dxy.prevClose, 103.5625);
});

test('derives gold/silver ratios and domestic premiums from live quotes', () => {
  const { quotes, macro } = parsePreciousMetalQuotes(QUOTES);
  const analytics = computePreciousMetalAnalytics(quotes, macro);
  const londonGoldCny = 3778.3 * 6.666 / TROY_OUNCE_GRAMS;
  assert.ok(Math.abs(analytics.londonGoldCny - londonGoldCny) < 1e-9);
  assert.ok(Math.abs(analytics.goldPremium - (812 - londonGoldCny)) < 1e-9);
  assert.ok(Math.abs(analytics.goldSilverRatio - 3778.3 / 46.01) < 1e-9);
  assert.ok(Math.abs(analytics.domesticGoldSilverRatio - 814.8 / 11.022) < 1e-9);
  assert.ok(Math.abs(analytics.silverPremium - (10972 - 46.01 * 6.666 / TROY_OUNCE_GRAMS * 1000)) < 1e-6);
  assert.ok(Math.abs(analytics.shfeSpotSpread - 2.8) < 1e-9);

  const partial = computePreciousMetalAnalytics(quotes.filter(item => item.id !== 'XAG'), []);
  assert.equal(partial.goldSilverRatio, null);
  assert.equal(partial.londonGoldCny, null);
  assert.equal(partial.goldPremium, null);
});

test('parses Sina daily and minute history for international and SHFE metals', () => {
  const daily = parsePreciousMetalDaily('/*<script>location.href=\'//sina.com\';</script>*/\nvar x=([{"date":"2026-11-16","open":"1","high":"2","low":"0.5","close":"1.5","volume":"0"},{"d":"2026-11-17","o":"1.5","h":"2.5","l":"1","c":"2","v":"10"},{"date":"bad","close":"3"}]);', 5);
  assert.deepEqual(daily.map(row => [row.date, row.close]), [['2026-11-16', 1.5], ['2026-11-17', 2]]);
  assert.equal(parsePreciousMetalDaily('var x=([{"date":"2026-11-16","close":"1"},{"date":"2026-11-17","close":"2"}]);', 1).length, 1);
  assert.deepEqual(parsePreciousMetalDaily('not jsonp'), []);

  const global = parsePreciousMetalMinute('var t=({"minLine_1d":[["2026-11-18","3849.170","LIFFE","","07:00","3854.220","0","0","3853.710","2026-11-18 07:00:00"],["07:01","3853.750","0","0","3854.243","2026-11-18 07:01:00"]]});', 'global');
  assert.equal(global.prevClose, 3849.17);
  assert.equal(global.date, '2026-11-18');
  assert.deepEqual(global.points, [{ time:'07:00', price:3854.22, average:3853.71 }, { time:'07:01', price:3853.75, average:3854.243 }]);

  const inner = parsePreciousMetalMinute('var t=([["21:00","832.820","832.831","917","142058","834.660","2026-11-18"],["21:01","833.060","832.849","437","142090"]]);', 'inner');
  assert.equal(inner.prevClose, 834.66);
  assert.deepEqual(inner.points.map(point => [point.time, point.price, point.average]), [['21:00', 832.82, 832.831], ['21:01', 833.06, 832.849]]);
});

test('history requests are limited to allowlisted instruments and ranges', () => {
  const daily = preciousMetalHistoryRequest('XAU', '1y');
  assert.equal(daily.limit, 260);
  assert.match(daily.url, /^https:\/\/stock2\.finance\.sina\.com\.cn\/futures\/api\/jsonp\.php\/.+GlobalFuturesService\.getGlobalFuturesDailyKLine\?symbol=XAU$/);
  assert.match(preciousMetalHistoryRequest('AU0', 'intraday').url, /InnerFuturesNewService\.getMinLine\?symbol=AU0$/);
  assert.match(preciousMetalHistoryRequest('AG0', '3m').url, /InnerFuturesNewService\.getDailyKLine\?symbol=AG0$/);
  assert.equal(preciousMetalHistoryRequest('AU9999', '1m'), null, 'SGE spot has no public history endpoint');
  assert.equal(preciousMetalHistoryRequest('XAU', '10y'), null);
  assert.equal(preciousMetalHistoryRequest('../XAU', '1m'), null);
  assert.equal(preciousMetalHistoryRequest('hf_XAU', '1m'), null);
  assert.ok(PRECIOUS_METAL_INSTRUMENTS.every(item => /^[A-Z0-9]+$/.test(item.id)));
});
