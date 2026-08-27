'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLimitPoolPayload } = require('../limit-pools');

test('limit pool parser normalizes price, symbols and side-specific board fields', () => {
  const up = normalizeLimitPoolPayload({ data:{ tc:1, qdate:20260827, pool:[{
    c:'002155', m:0, n:'湖南黄金', p:27020, zdp:10.02, amount:383632336, ltsz:42218720737,
    tshare:42222838450, hs:0.91, fund:564939509, fbt:92500, lbt:92500, zbc:0, hybk:'贵金属', zttj:{ days:1, ct:2 },
  }] } }, 'up', '20260827');
  assert.deepEqual(up.data[0], {
    code:'002155', symbol:'sz002155', name:'湖南黄金', price:27.02, pct:10.02,
    amount:383632336, floatMarketCap:42218720737, marketCap:42222838450, turnover:0.91,
    sealAmount:564939509, firstSealTime:92500, lastSealTime:92500, boardAmount:null,
    continuousCount:2, openCount:0, industry:'贵金属',
  });

  const down = normalizeLimitPoolPayload({ data:{ tc:1, qdate:20260827, pool:[{
    c:'603839', m:1, n:'安正时尚', p:6490, zdp:-9.99, fund:1402489, lbt:150000, fba:123562304,
    days:1, oc:7, hybk:'服装家纺',
  }] } }, 'down', '20260827');
  assert.equal(down.data[0].symbol, 'sh603839');
  assert.equal(down.data[0].price, 6.49);
  assert.equal(down.data[0].continuousCount, 1);
  assert.equal(down.data[0].openCount, 7);
  assert.equal(down.data[0].boardAmount, 123562304);
});

test('limit pool parser treats an empty pool as a valid no-data response', () => {
  const result = normalizeLimitPoolPayload({ rc:0, data:null }, 'down', '20260829');
  assert.deepEqual(result, { side:'down', date:'20260829', total:0, data:[] });
});
