'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySignal, parseTencentOrderBook } = require('../order-book');

function quote(fields, symbol = 'sh600000') {
  return `v_${symbol}="${fields.join('~')}";`;
}

test('parses Tencent level-5 bids and asks into a stable order-book shape', () => {
  const fields = ['1', '测试股份', '600000', '10', '9.9', '10', '100', '0', '0',
    '9.99', '100', '9.98', '90', '9.97', '80', '9.96', '70', '9.95', '60',
    '10.01', '110', '10.02', '100', '10.03', '90', '10.04', '80', '10.05', '70',
    'x', '2026-01-01 10:00', '0.1', '1', '10.2', '9.8'];
  const result = parseTencentOrderBook('sh600000', quote(fields));
  assert.equal(result.name, '测试股份');
  assert.equal(result.price, 10);
  assert.deepEqual(result.bids[0], { level:1, price:9.99, volume:100 });
  assert.deepEqual(result.asks[4], { level:5, price:10.05, volume:70 });
  assert.equal(result.totals.bidVolume, 400);
  assert.equal(result.totals.askVolume, 450);
  assert.equal(result.signal.type, 'neutral');
});

test('classifies clear order-book imbalance as buy or sell signal', () => {
  assert.equal(classifySignal({ pct:0, imbalance:2, spread:0.01 }).type, 'buy');
  assert.equal(classifySignal({ pct:0, imbalance:0.4, spread:0.01 }).type, 'sell');
  assert.equal(classifySignal({ pct:0, imbalance:1, spread:0.02 }).type, 'neutral');
});

test('returns null when the requested symbol is absent', () => {
  assert.equal(parseTencentOrderBook('sh600000', 'v_sz000001="1~other";'), null);
});
