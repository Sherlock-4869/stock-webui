'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBoardLadder,
  buildRecapMarkdown,
  computeMarketSentiment,
  normalizeBrokenLimitPoolPayload,
  normalizeIndexTurnoverDelta,
  normalizeYesterdayLimitPoolPayload,
} = require('../market-recap');

test('normalizes broken limit pool and filters unsupported symbols', () => {
  const result = normalizeBrokenLimitPoolPayload({
    data:{
      qdate:20261124,
      tc:2,
      pool:[
        { c:'600001', m:1, n:'示例甲', p:12340, zdp:4.5, amount:5e8, ltsz:8e9, hs:6.2, zf:9.5, fbt:93500, zbc:2, hybk:'半导体' },
        { c:'830001', m:0, n:'北交示例', p:8000, zdp:12.1, amount:1e8, ltsz:1e9, hs:5.0, zf:15, fbt:100500, zbc:1, hybk:'软件' },
      ],
    },
  }, '20261124');

  assert.equal(result.date, '20261124');
  assert.equal(result.total, 2);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].symbol, 'sh600001');
  assert.equal(result.data[0].price, 12.34);
  assert.equal(result.data[0].brokenCount, 2);
  assert.equal(result.data[1].symbol, '');
});

test('normalizes yesterday limit pool and computes average premium and win rate', () => {
  const result = normalizeYesterdayLimitPoolPayload({
    data:{
      qdate:20261124,
      tc:3,
      pool:[
        { c:'000001', m:0, n:'标的A', p:10500, zdp:5.0, amount:2e8, hs:8.1, zttj:{ ct:3 }, hybk:'机器人' },
        { c:'600100', m:1, n:'标的B', p:20000, zdp:-2.0, amount:3e8, hs:4.2, zttj:{ ct:1 }, hybk:'机器人' },
        { c:'300001', m:0, n:'标的C', p:15000, zdp:3.0, amount:1e8, hs:5.0, zttj:{ ct:2 }, hybk:'光伏' },
      ],
    },
  }, '20261124');

  assert.equal(result.total, 3);
  assert.equal(result.avgPct, 2);
  assert.equal(result.risingCount, 2);
  assert.equal(result.fallingCount, 1);
  assert.equal(result.winRate, 66.7);
  assert.equal(result.data[0].symbol, 'sz000001');
  assert.equal(result.data[0].yesterdayContinuous, 3);
});

test('builds board ladder sorted from highest board down and ranks hot themes', () => {
  const ladder = buildBoardLadder([
    { code:'000001', symbol:'sz000001', name:'一板甲', continuousCount:1, firstSealTime:94500, industry:'半导体' },
    { code:'000002', symbol:'sz000002', name:'三板龙', continuousCount:3, firstSealTime:93012, industry:'机器人' },
    { code:'600003', symbol:'sh600003', name:'一板乙', continuousCount:1, firstSealTime:93100, industry:'机器人' },
    { code:'600004', symbol:'sh600004', name:'二板丙', continuousCount:2, firstSealTime:93500, industry:'机器人' },
  ]);

  assert.equal(ladder.maxBoard, 3);
  assert.equal(ladder.total, 4);
  assert.deepEqual(ladder.levels.map(l => l.boards), [3, 2, 1]);
  assert.equal(ladder.levels[0].label, '3 连板');
  assert.equal(ladder.levels[2].label, '首板');
  assert.equal(ladder.levels[2].stocks[0].name, '一板乙');
  assert.deepEqual(ladder.hotThemes[0], { industry:'机器人', count:3 });
});

test('computes index turnover delta from common Shanghai and Shenzhen sessions', () => {
  const delta = normalizeIndexTurnoverDelta(
    [
      ['2026-11-21', '3300', '3310', '3320', '3290', '400000000', {}, '0', '50000000'],
      ['2026-11-24', '3315', '3350', '3360', '3310', '450000000', {}, '0', '60000000'],
    ],
    [
      ['2026-11-21', '10500', '10550', '10600', '10480', '500000000', {}, '0', '50000000'],
      ['2026-11-24', '10560', '10700', '10720', '10540', '550000000', {}, '0', '60000000'],
    ]
  );

  assert.deepEqual(delta, {
    latestDate:'2026-11-24',
    previousDate:'2026-11-21',
    diffRatio:20,
  });
  assert.equal(normalizeIndexTurnoverDelta([['2026-11-24', '1', '1', '1', '1', '10']], []), null);
});

test('computes sentiment score, seal rate and generates structured recap markdown', () => {
  const sentiment = computeMarketSentiment({
    breadth:{ rising:3900, falling:1000, flat:100 },
    limitUpTotal:80,
    limitDownTotal:5,
    brokenTotal:20,
    yesterdayAvgPct:3.5,
    turnoverDiffRatio:12,
  });

  assert.equal(sentiment.riseRatio, 78);
  assert.equal(sentiment.sealRate, 80);
  assert.ok(sentiment.score >= 72);
  assert.equal(sentiment.label, '情绪亢奋');

  const markdown = buildRecapMarkdown({
    date:'20261124',
    sentiment,
    breadth:{ rising:3900, falling:1000, flat:100 },
    trading:{ amount:1.65e12 },
    turnoverComparison:{ diffRatio:12 },
    limits:{ upTotal:80, downTotal:5, brokenTotal:20 },
    yesterdayLimit:{ total:65, avgPct:3.5, winRate:75.4 },
    mainFlow:{ mainNet:125e8, superLargeNet:90e8, largeNet:35e8 },
    indexes:[{ code:'000001', name:'上证指数', price:3350.12, pct:1.25 }],
    ladder:{ maxBoard:5, levels:[{ boards:5, label:'5 连板', count:1, stocks:[{ name:'龙头股', industry:'机器人' }] }], hotThemes:[{ industry:'机器人', count:12 }] },
    sectors:{ rising:[{ name:'半导体', pct:4.2 }], falling:[{ name:'煤炭', pct:-1.1 }], inflow:[{ name:'半导体', mainNetInflow:32e8 }] },
  });

  assert.match(markdown, /# A 股每日市场复盘（2026-11-24）/);
  assert.match(markdown, /封板率 80%/);
  assert.match(markdown, /1\.65万亿/);
  assert.match(markdown, /龙头股\(机器人\)/);
  assert.match(markdown, /领涨行业/);
});
