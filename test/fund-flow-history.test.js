'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAsyncTaskQueue,
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
  parseSinaFundFlowHistoryPayload,
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

test('Sina fund flow parser preserves its yuan-denominated net-flow fields', () => {
  const rows = parseSinaFundFlowHistoryPayload([
    {
      opendate:'2026-07-30', trade:'12.50', changeratio:'0.0125', netamount:'5',
      r0:'100', r1:'200', r2:'300', r3:'400', r0_net:'10', r1_net:'20', r2_net:'-30', r3_net:'-40',
    },
    {
      opendate:'2026-07-29', trade:'12.00', changeratio:'-0.01', netamount:'8',
      r0:'50', r1:'50', r2:'100', r3:'100', r0_net:'-5', r1_net:'4', r2_net:'1', r3_net:'0',
    },
  ]);
  assert.deepEqual(rows, [
    {
      date:'2026-07-29', mainNet:-1, smallNet:0, mediumNet:1, largeNet:4, superLargeNet:-5,
      mainRatio:-0.33333333333333337, smallRatio:0, mediumRatio:0.33333333333333337,
      largeRatio:1.3333333333333335, superLargeRatio:-1.6666666666666667, close:12, pct:-1,
    },
    {
      date:'2026-07-30', mainNet:30, smallNet:-40, mediumNet:-30, largeNet:20, superLargeNet:10,
      mainRatio:3, smallRatio:-4, mediumRatio:-3, largeRatio:2, superLargeRatio:1, close:12.5, pct:1.25,
    },
  ]);
  assert.throws(() => parseSinaFundFlowHistoryPayload([]), /empty/);
});

test('Sina net amount is consistent with its unscaled bucket net flows', () => {
  const [row] = parseSinaFundFlowHistoryPayload([{
    opendate:'2026-08-11', trade:'1346.2900', changeratio:'-0.00190531', netamount:'-298190789.7300',
    r0:'2414648036.8200', r1:'1031553421.9000', r2:'110357358.2400', r3:'0',
    r0_net:'-323262091.1200', r1_net:'26308851.3500', r2_net:'-1237549.9600', r3_net:'0',
  }]);
  assert.equal(row.mainNet, -296953239.77);
  assert.ok(Math.abs((row.superLargeNet + row.largeNet + row.mediumNet + row.smallNet) - (-298190789.73)) < 0.0001);
  assert.ok(Math.abs(row.mainNet - (row.superLargeNet + row.largeNet)) < 0.0001);
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

test('loader accepts a complete corrected Sina fallback without mixing its source metadata', async () => {
  const saved = [];
  const loader = createFundFlowHistoryLoader({
    now:() => 1000,
    acceptedSources:['eastmoney-daykline', 'sina-money-flow-v2'],
    fetchData:async () => ({ data:[{ date:'2026-07-30', mainNet:300000 }], source:'sina-money-flow-v2' }),
    savePersisted:async (symbol, value) => saved.push({ symbol, value }),
  });

  const result = await loader.load('sh600519');
  assert.deepEqual(result.meta, {
    source:'sina-money-flow-v2', cached:false, stale:false, fetchedAt:1000,
  });
  assert.equal(saved[0].value.source, 'sina-money-flow-v2');
  assert.equal(saved[0].value.data[0].mainNet, 300000);
});

test('loader discards the old wrongly-scaled Sina cache and refetches corrected data', async () => {
  let calls = 0;
  const loader = createFundFlowHistoryLoader({
    now:() => 1000,
    acceptedSources:['eastmoney-daykline', 'sina-money-flow-v2'],
    loadPersisted:async () => ({
      data:[{ date:'2026-07-30', mainNet:3000000000 }], source:'sina-money-flow', fetchedAt:new Date(1000),
    }),
    fetchData:async () => {
      calls += 1;
      return { data:[{ date:'2026-07-30', mainNet:300000 }], source:'sina-money-flow-v2' };
    },
  });
  const result = await loader.load('sh600519');
  assert.equal(calls, 1);
  assert.equal(result.data[0].mainNet, 300000);
  assert.equal(result.meta.source, 'sina-money-flow-v2');
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
