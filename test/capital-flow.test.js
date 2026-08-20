'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consecutiveFlowDays,
  flowRankingFields,
  mergeFlowSeries,
  normalizeFlowRankingRow,
  parseIntradayFlowPayload,
} = require('../capital-flow');

test('capital flow rankings map every supported period without changing units', () => {
  const row = {
    f2:12.34, f3:2.5, f12:'600000', f13:1, f14:'示例银行',
    f62:100, f184:1.5, f267:300, f268:2.5, f164:500, f165:3.5, f174:1000, f175:4.5,
    f176:600, f177:2.1, f178:400, f179:1.4, f180:-300, f181:-1.1, f182:-700, f183:-2.4,
  };
  assert.deepEqual(normalizeFlowRankingRow(row, { period:'today' }).symbol, 'sh600000');
  const tenDay = normalizeFlowRankingRow(row, { period:'10d' });
  assert.equal(tenDay.mainNet, 1000);
  assert.equal(tenDay.mainRatio, 4.5);
  assert.equal(tenDay.superLargeNet, 600);
  assert.equal(tenDay.smallNet, -700);
  assert.match(flowRankingFields('3d'), /f267/);
  assert.doesNotMatch(flowRankingFields('3d'), /f174/);
});

test('intraday parser and combined market series preserve flow categories', () => {
  const first = parseIntradayFlowPayload({ rc:0, data:{ code:'000001', name:'沪市', klines:['2026-08-20 10:00,10,-2,-3,4,6'] } });
  const second = parseIntradayFlowPayload({ rc:0, data:{ code:'399001', name:'深市', klines:['2026-08-20 10:00,20,-4,-6,8,12'] } });
  const combined = mergeFlowSeries([first.data, second.data], 'time');
  assert.deepEqual(combined, [{
    time:'2026-08-20 10:00', mainNet:30, smallNet:-6, mediumNet:-9, largeNet:12, superLargeNet:18,
  }]);
});

test('consecutive flow streak follows the latest direction', () => {
  const rows = [
    { date:'2026-08-17', mainNet:-10 },
    { date:'2026-08-18', mainNet:20 },
    { date:'2026-08-19', mainNet:30 },
    { date:'2026-08-20', mainNet:40 },
  ];
  assert.deepEqual(consecutiveFlowDays(rows), { direction:'in', days:3, amount:90 });
  assert.deepEqual(consecutiveFlowDays([{ date:'2026-08-20', mainNet:0 }]), { direction:'flat', days:0, amount:0 });
});
