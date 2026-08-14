'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fundQuoteFromProfile } = require('../fund-quote');

test('fund quote uses the latest disclosed NAV and daily return', () => {
  const quote = fundQuoteFromProfile('000001', {
    name:'华夏成长混合',
    netWorth:[
      { timestamp:1723507200000, value:1.2, dailyReturn:0.5 },
      { timestamp:1723593600000, value:1.212, dailyReturn:1 },
    ],
  });
  assert.equal(quote.symbol, 'fund000001');
  assert.equal(quote.name, '华夏成长混合');
  assert.equal(quote.price, 1.212);
  assert.equal(quote.prevClose, 1.2);
  assert.ok(Math.abs(quote.chg - 0.012) < 1e-12);
  assert.equal(quote.pct, 1);
  assert.equal(quote.navDate, '2024-08-14');
  assert.equal(quote.securityType, 'FUND');
});

test('fund quote rejects invalid codes and missing NAV data', () => {
  assert.throws(() => fundQuoteFromProfile('bad', { netWorth:[] }), /Invalid fund code/);
  assert.throws(() => fundQuoteFromProfile('000001', { netWorth:[] }), /NAV is unavailable/);
});
