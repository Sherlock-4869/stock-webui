'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTencentEtfType,
  normalizeSecuritySearchQuery,
  parseTencentSecuritySearch,
} = require('../stock-search');

test('security search removes spaces from Chinese names without changing English queries', () => {
  assert.equal(normalizeSecuritySearchQuery(' 纳斯达克 ETF 华夏 '), '纳斯达克ETF华夏');
  assert.equal(normalizeSecuritySearchQuery('Bank of America'), 'Bank of America');
});

test('Tencent security search accepts and classifies QDII ETFs', () => {
  assert.equal(isTencentEtfType('ETF'), true);
  assert.equal(isTencentEtfType('QDII-ETF'), true);
  assert.equal(isTencentEtfType('QDII-LOF'), false);
  const rows = parseTencentSecuritySearch('v_hint="sh~513300~\\u7eb3\\u65af\\u8fbe\\u514bETF\\u534e\\u590f~nsdketfhx~QDII-ETF^us~aapl.oq~Apple~apple~GP^us~ixic~Nasdaq~nasdaq~ZS"');
  assert.deepEqual(rows, [
    { sym:'sh513300', name:'纳斯达克ETF华夏', market:'SH', code:'513300', securityType:'ETF' },
    { sym:'usAAPL', name:'Apple', market:'US', code:'AAPL', securityType:'STOCK' },
  ]);
});
