'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAINLAND_MARKET_BREADTH_CODES,
  MAINLAND_MARKET_BREADTH_FS,
  summarizeMarketBreadth,
} = require('../market-overview');

test('mainland breadth uses the broad Shenzhen composite, not the component basket', () => {
  assert.deepEqual(MAINLAND_MARKET_BREADTH_CODES, ['000001', '399106']);
  assert.equal(MAINLAND_MARKET_BREADTH_CODES.includes('399001'), false);
});

test('market breadth follows the common沪深京 A-share scope and excludes suspended rows', () => {
  assert.match(MAINLAND_MARKET_BREADTH_FS, /m:0\+t:81\+s:2048/);
  const result = summarizeMarketBreadth([
    { f3:2.1, f5:10, f6:100, f20:1000, f21:800 },
    { f3:-1.2, f5:20, f6:200, f20:2000, f21:1600 },
    { f3:0, f5:30, f6:300, f20:3000, f21:2400 },
    { f3:'-', f5:999, f6:999, f20:999, f21:999 },
  ]);
  assert.deepEqual(result, {
    rising:1, falling:1, flat:1, quoted:3,
    trading:{ volume:60, amount:600, totalMarketCap:6000, floatMarketCap:4800 },
  });
});
