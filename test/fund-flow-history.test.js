'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
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

test('daily realtime points replace the same date and accumulate across dates', () => {
  const first = mergeFundFlowHistory([
    { date:'2026-07-28', mainNet:10, mainRatio:1 },
    { date:'2026-07-29', mainNet:20, mainRatio:2 },
  ], { date:'2026-07-29', mainNet:25, mainRatio:2.5 });
  assert.deepEqual(first, [
    { date:'2026-07-28', mainNet:10, mainRatio:1 },
    { date:'2026-07-29', mainNet:25, mainRatio:2.5 },
  ]);

  const nextDay = mergeFundFlowHistory(first, { date:'2026-07-30', mainNet:30 }, 2);
  assert.deepEqual(nextDay, [
    { date:'2026-07-29', mainNet:25, mainRatio:2.5 },
    { date:'2026-07-30', mainNet:30 },
  ]);
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
  await new Promise(resolve => setImmediate(resolve));
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

test('cold process hydrates fresh history from persistent cache without calling upstream', async () => {
  let upstreamCalls = 0;
  const loader = createFundFlowHistoryLoader({
    now:() => 5000,
    loadPersisted:async symbol => ({
      data:[{ date:'2026-07-29', mainNet:66 }],
      fetchedAt:new Date(5000),
      source:`database:${symbol}`,
    }),
    fetchPayload:async () => {
      upstreamCalls += 1;
      return payload(99);
    },
  });

  const rows = await loader.load('sh600519');
  assert.equal(rows[0].mainNet, 66);
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(loader.info('sh600519'), {
    fetchedAt:5000,
    source:'database:sh600519',
    persisted:true,
    stale:false,
  });
});

test('successful upstream history records source metadata and persists rows', async () => {
  const saved = [];
  const loader = createFundFlowHistoryLoader({
    now:() => 7000,
    fetchPayload:async () => ({ payload:payload(123), source:'fallback-source' }),
    savePersisted:async (symbol, value) => saved.push({ symbol, value }),
  });

  assert.equal((await loader.load('sz000001'))[0].mainNet, 123);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].symbol, 'sz000001');
  assert.equal(saved[0].value.source, 'fallback-source');
  assert.equal(saved[0].value.data[0].mainNet, 123);
  assert.equal(loader.info('sz000001').source, 'fallback-source');
});
