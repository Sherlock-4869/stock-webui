'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAsyncTaskQueue,
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
} = require('../fund-flow-history');

function payload(mainNet, date = '2026-07-30') {
  return {
    rc:0,
    data:{ klines:[`${date},${mainNet},2,3,4,5,6,7,8,9,10,11,12`] },
  };
}

test('Eastmoney fund flow parser maps fields and normalizes chronological order', () => {
  const rows = parseFundFlowHistoryPayload({
    rc:0,
    data:{
      klines:[
        '2026-07-30,100,2,3,4,5,6,7,8,9,10,11,12',
        '2026-07-29,-200,-2,-3,-4,-5,-6,-7,-8,-9,-10,10,-11',
      ],
    },
  });
  assert.deepEqual(rows, [
    {
      date:'2026-07-29', mainNet:-200, smallNet:-2, mediumNet:-3, largeNet:-4,
      superLargeNet:-5, mainRatio:-6, smallRatio:-7, mediumRatio:-8,
      largeRatio:-9, superLargeRatio:-10, close:10, pct:-11,
    },
    {
      date:'2026-07-30', mainNet:100, smallNet:2, mediumNet:3, largeNet:4,
      superLargeNet:5, mainRatio:6, smallRatio:7, mediumRatio:8,
      largeRatio:9, superLargeRatio:10, close:11, pct:12,
    },
  ]);
  assert.throws(() => parseFundFlowHistoryPayload({ rc:1, data:null }), /rc=1/);
  assert.throws(() => parseFundFlowHistoryPayload({ rc:0, data:{ klines:[] } }), /empty/);
});

test('request queue caps concurrent work and waiting tasks', async () => {
  const queue = createAsyncTaskQueue({ concurrency:1, maxQueued:0 });
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(queue.run(async () => {}), /queue is full/);
  release();
  await first;
});

test('today realtime point replaces the daily-history value without changing prior rows', () => {
  const merged = mergeFundFlowHistory([
    { date:'2026-08-10', mainNet:100, largeNet:40 },
    { date:'2026-08-12', mainNet:200, largeNet:80 },
  ], {
    date:'2026-08-12', mainNet:300, largeNet:120, updatedAt:1786501326,
  });
  assert.deepEqual(merged, [
    { date:'2026-08-10', mainNet:100, largeNet:40 },
    { date:'2026-08-12', mainNet:300, largeNet:120, updatedAt:1786501326 },
  ]);
});

test('loader stores only Eastmoney data in its original yuan unit', async () => {
  const saved = [];
  const loader = createFundFlowHistoryLoader({
    now:() => 1000,
    fetchData:async () => parseFundFlowHistoryPayload(payload(12345678)),
    savePersisted:async (symbol, value) => saved.push({ symbol, value }),
  });

  const result = await loader.load('sh600519');
  assert.equal(result.data[0].mainNet, 12345678);
  assert.deepEqual(result.meta, {
    source:'eastmoney-daykline', cached:false, stale:false, fetchedAt:1000,
  });
  assert.equal(saved[0].symbol, 'sh600519');
  assert.equal(saved[0].value.source, 'eastmoney-daykline');
  assert.equal(saved[0].value.data[0].mainNet, 12345678);
});

test('loader falls back only to a recent cache from the same Eastmoney source', async () => {
  let now = 1000;
  const loader = createFundFlowHistoryLoader({
    now:() => now,
    freshMs:100,
    fallbackMs:500,
    loadPersisted:async () => ({
      data:[{ date:'2026-07-30', mainNet:8000000 }],
      source:'eastmoney-daykline', fetchedAt:new Date(1000),
    }),
    fetchData:async () => { throw new Error('Eastmoney unavailable'); },
    attempts:1,
  });

  assert.equal((await loader.load('sh600519')).meta.stale, false);
  now = 1101;
  const fallback = await loader.load('sh600519');
  assert.equal(fallback.data[0].mainNet, 8000000);
  assert.deepEqual(fallback.meta, {
    source:'eastmoney-daykline', cached:true, stale:true, fetchedAt:1000,
  });
});

test('forced history refresh bypasses a fresh same-source cache', async () => {
  let calls = 0;
  const loader = createFundFlowHistoryLoader({
    now:() => 1000,
    loadPersisted:async () => ({
      data:[{ date:'2026-07-30', mainNet:100 }], source:'eastmoney-daykline', fetchedAt:new Date(1000),
    }),
    fetchData:async () => {
      calls += 1;
      return [{ date:'2026-07-30', mainNet:200 }];
    },
  });
  assert.equal((await loader.load('sh600519')).data[0].mainNet, 100);
  assert.equal((await loader.load('sh600519', { force:true })).data[0].mainNet, 200);
  assert.equal(calls, 1);
});

test('loader rejects foreign-source and expired cached fund-flow data', async () => {
  const foreignLoader = createFundFlowHistoryLoader({
    now:() => 1000,
    loadPersisted:async () => ({
      data:[{ date:'2026-07-30', mainNet:8 }], source:'sina-money-flow', fetchedAt:new Date(1000),
    }),
    fetchData:async () => { throw new Error('Eastmoney unavailable'); },
    attempts:1,
  });
  await assert.rejects(foreignLoader.load('sh600519'), /Eastmoney unavailable/);

  const expiredLoader = createFundFlowHistoryLoader({
    now:() => 62000,
    fallbackMs:500,
    loadPersisted:async () => ({
      data:[{ date:'2026-07-30', mainNet:8000000 }],
      source:'eastmoney-daykline', fetchedAt:new Date(1000),
    }),
    fetchData:async () => { throw new Error('Eastmoney unavailable'); },
    attempts:1,
  });
  await assert.rejects(expiredLoader.load('sh600519'), /Eastmoney unavailable/);
});
