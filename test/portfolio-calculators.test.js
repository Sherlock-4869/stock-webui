'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../public/portfolio-calculators');

test('analyzes portfolio realized PnL, win rate, profit factor and market allocation', () => {
  const stats = calc.analyzePortfolio(
    [
      { symbol: 'sh600519', name: '贵州茅台', quantity: 100, cost: 1500 },
      { symbol: 'sh510300', name: '沪深300ETF', quantity: 10000, cost: 4.0 },
    ],
    [
      { at: 1000, symbol: 'sz000001', name: '平安银行', side: 'BUY', quantity: 1000, price: 10 },
      { at: 2000, symbol: 'sz000001', name: '平安银行', side: 'SELL', quantity: 600, price: 12 },
      { at: 3000, symbol: 'sz000001', name: '平安银行', side: 'SELL', quantity: 400, price: 9 },
    ],
    {
      sh600519: { price: 1650 },
      sh510300: { price: 4.2 },
    }
  );

  assert.equal(stats.realizedProfit, 800); // +1200 and -400
  assert.equal(stats.winCount, 1);
  assert.equal(stats.lossCount, 1);
  assert.equal(stats.winRatePct, 50);
  assert.equal(stats.profitFactor, 3); // 1200 / 400
  assert.equal(stats.totalMarketValue, 207000);
  assert.equal(stats.unrealizedProfit, 17000);
  assert.equal(stats.marketAllocation.length, 2);
});

test('compares portfolio weighted return against CSI 300 benchmark and tracks max drawdown', () => {
  const cmp = calc.comparePortfolioWithBenchmark(
    {
      sh600519: [
        { date: '2026-11-18', close: 100 },
        { date: '2026-11-19', close: 110 },
        { date: '2026-11-20', close: 99 },
        { date: '2026-11-23', close: 105 },
        { date: '2026-11-24', close: 115 },
      ],
    },
    { sh600519: 100000 },
    [
      { date: '2026-11-18', close: 4000 },
      { date: '2026-11-19', close: 4020 },
      { date: '2026-11-20', close: 4000 },
      { date: '2026-11-23', close: 4040 },
      { date: '2026-11-24', close: 4200 },
    ]
  );

  assert.ok(cmp);
  assert.equal(cmp.portfolioReturnPct, 15);
  assert.equal(cmp.benchmarkReturnPct, 5);
  assert.equal(cmp.alphaPct, 10);
  assert.equal(cmp.maxDrawdownPct, 10); // 1.10 -> 0.99 is -10%
});

test('calculates cost dilution both forward by shares and reverse by target cost', () => {
  const forward = calc.calculateCostDilution({
    currentShares: 1000,
    currentCost: 25,
    buyPrice: 20,
    addShares: 1000,
  });
  assert.equal(forward.newCost, 22.5);
  assert.equal(forward.reboundNeededBeforePct, 25);
  assert.equal(forward.reboundNeededAfterPct, 12.5);

  const reverse = calc.calculateCostDilution({
    currentShares: 1000,
    currentCost: 30,
    buyPrice: 20,
    targetCost: 22,
  });
  assert.equal(reverse.addShares, 4000);
  assert.equal(reverse.newCost, 22);
});

test('generates arithmetic and geometric grid plans, DCA backtest, position risk and DRIP schedule', () => {
  const grid = calc.calculateGridPlan({
    lowerPrice: 16,
    upperPrice: 24,
    gridCount: 4,
    perGridAmount: 10000,
    mode: 'arithmetic',
  });
  assert.equal(grid.levels.length, 4);
  assert.equal(grid.amplitudePct, 50);
  assert.ok(grid.totalMaxCapital > 0);

  const dca = calc.simulateCompoundDca({ periodicAmount: 1000, periodsPerYear: 12, annualReturnPct: 12, years: 2 });
  assert.equal(dca.principal, 24000);
  assert.ok(dca.finalBalance > 24000);

  const histDca = calc.backtestHistoricalDca(
    [10, 8, 9, 10, 11, 12].map((close, i) => ({ date: `2026-11-1${i}`, close })),
    { periodicAmount: 1000, intervalSessions: 2 }
  );
  assert.equal(histDca.installments, 3);
  assert.ok(histDca.finalValue > histDca.totalInvested);

  const risk = calc.calculatePositionRisk({
    accountCapital: 200000,
    maxRiskPct: 1.5,
    entryPrice: 25,
    stopLossPrice: 22,
  });
  assert.equal(risk.maxLossAmount, 3000);
  assert.equal(risk.recommendedShares, 1000);
  assert.equal(risk.rMultipleTargets[1].targetPrice, 31); // 2R: 25 + 3*2

  const drip = calc.calculateDividendCompounding({
    initialPrincipal: 100000,
    annualContribution: 0,
    dividendYieldPct: 5,
    priceGrowthPct: 3,
    years: 5,
    reinvest: true,
  });
  assert.equal(drip.schedule.length, 5);
  assert.ok(drip.finalWealth > 140000);
});
