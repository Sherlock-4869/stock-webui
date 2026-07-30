'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFundFlowHistoryLoader,
  parseFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
} = require('../fund-flow-history');

function payload(mainNet, date = '2026-07-30') {
  return {
    rc:0,
    data:{
      klines:[`${date},${mainNet},2,3,4,5,6,7,8,9,10,11,12`],
    },
  };
}

test('fund flow payload parser maps upstream fields', () => {
  const rows = parseFundFlowHistoryPayload(payload(100));
  assert.deepEqual(rows, [{
    date:'2026-07-30', mainNet:100, smallNet:2, mediumNet:3, largeNet:4,
    superLargeNet:5, mainRatio:6, smallRatio:7, mediumRatio:8,
    largeRatio:9, superLargeRatio:10, close:11, pct:12,
  }]);
  assert.throws(() => parseFundFlowHistoryPayload({ rc:1, data:null }), /rc=1/);
  assert.throws(() => parseFundFlowHistoryPayload({ rc:0, data:{ klines:[] } }), /empty/);
});

test('cold fund flow requests retry before failing', async () => {
  let calls = 0;
  const waits = [];
  const loader = createFundFlowHistoryLoader({
    fetchPayload:async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporary upstream failure');
      return payload(300);
    },
    wait:async delay => waits.push(delay),
  });
  const rows = await loader.load('sh600519');
  assert.equal(rows[0].mainNet, 300);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test('concurrent cold requests share one upstream request', async () => {
  let calls = 0;
  let resolvePayload;
  const loader = createFundFlowHistoryLoader({
    fetchPayload:async () => {
      calls += 1;
      return new Promise(resolve => { resolvePayload = resolve; });
    },
  });
  const first = loader.load('sz000001');
  const second = loader.load('sz000001');
  assert.equal(calls, 1);
  resolvePayload(payload(88));
  const [firstRows, secondRows] = await Promise.all([first, second]);
  assert.equal(firstRows[0].mainNet, 88);
  assert.equal(secondRows[0].mainNet, 88);
});

test('expired cache is served immediately while refreshing in background', async () => {
  let now = 1000;
  let calls = 0;
  let resolveRefresh;
  const loader = createFundFlowHistoryLoader({
    now:() => now,
    fetchPayload:async () => {
      calls += 1;
      if (calls === 1) return payload(10);
      return new Promise(resolve => { resolveRefresh = resolve; });
    },
  });
  assert.equal((await loader.load('sh600000'))[0].mainNet, 10);
  now += DEFAULT_FRESH_MS + 1;
  assert.equal((await loader.load('sh600000'))[0].mainNet, 10);
  assert.equal(calls, 2);
  resolveRefresh(payload(20));
  await loader.pending.get('sh600000');
  assert.equal((await loader.load('sh600000'))[0].mainNet, 20);
});
