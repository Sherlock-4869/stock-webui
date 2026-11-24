'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLhbInstitutionPayload,
  normalizeLhbListPayload,
  normalizeLhbSeatsPayload,
  normalizeMarginMarketPayload,
  normalizeMarginStocksPayload,
  normalizeUnlockPayload,
  stockSymbolFromCode,
} = require('../smart-money');

test('maps 6-digit A-share codes to Tencent symbols while skipping Beijing Stock Exchange', () => {
  assert.equal(stockSymbolFromCode('600519', '600519.SH'), 'sh600519');
  assert.equal(stockSymbolFromCode('000001', '000001.SZ'), 'sz000001');
  assert.equal(stockSymbolFromCode('300750'), 'sz300750');
  assert.equal(stockSymbolFromCode('830799', '830799.BJ'), '');
  assert.equal(stockSymbolFromCode('invalid'), '');
});

test('merges duplicate same-day LHB rows by stock and summarizes net buy counts', () => {
  const result = normalizeLhbListPayload({
    result:{
      data:[
        {
          SECURITY_CODE:'000001', SECUCODE:'000001.SZ', SECURITY_NAME_ABBR:'平安银行',
          TRADE_DATE:'2026-11-24 00:00:00', CLOSE_PRICE:11.2, CHANGE_RATE:10.02, TURNOVER_RATE:8.5,
          BILLBOARD_BUY_AMT:1.2e8, BILLBOARD_SELL_AMT:0.5e8, BILLBOARD_NET_AMT:0.7e8,
          EXPLANATION:'日涨幅偏离值达7%',
        },
        {
          SECURITY_CODE:'000001', SECUCODE:'000001.SZ', SECURITY_NAME_ABBR:'平安银行',
          TRADE_DATE:'2026-11-24 00:00:00', CLOSE_PRICE:11.2, CHANGE_RATE:10.02, TURNOVER_RATE:8.5,
          BILLBOARD_BUY_AMT:1.2e8, BILLBOARD_SELL_AMT:0.5e8, BILLBOARD_NET_AMT:0.7e8,
          EXPLANATION:'连续三个交易日内涨幅偏离值累计达20%',
        },
        {
          SECURITY_CODE:'600519', SECUCODE:'600519.SH', SECURITY_NAME_ABBR:'贵州茅台',
          TRADE_DATE:'2026-11-24 00:00:00', CLOSE_PRICE:1500, CHANGE_RATE:-3.1, TURNOVER_RATE:1.2,
          BILLBOARD_BUY_AMT:0.8e8, BILLBOARD_SELL_AMT:1.1e8, BILLBOARD_NET_AMT:-0.3e8,
          EXPLANATION:'日跌幅偏离值达7%',
        },
      ],
    },
  });

  assert.equal(result.tradeDate, '2026-11-24');
  assert.equal(result.total, 2);
  assert.equal(result.summary.netBuyCount, 1);
  assert.equal(result.summary.netSellCount, 1);
  assert.equal(result.summary.totalNetBuy, 4e7);
  assert.deepEqual(result.data[0].reasons, ['日涨幅偏离值达7%', '连续三个交易日内涨幅偏离值累计达20%']);
  assert.equal(result.data[0].symbol, 'sz000001');
});

test('normalizes LHB buy/sell seats and flags institution and northbound seats', () => {
  const seats = normalizeLhbSeatsPayload(
    {
      result:{
        data:[
          { OPERATEDEPT_CODE:'801', OPERATEDEPT_NAME:'机构专用', BUY:5e7, SELL:0, NET:5e7, RANK:1 },
          { OPERATEDEPT_CODE:'802', OPERATEDEPT_NAME:'深股通专用', BUY:3e7, SELL:1e7, NET:2e7, RANK:2 },
          { OPERATEDEPT_CODE:'801', OPERATEDEPT_NAME:'机构专用', BUY:5e7, SELL:0, NET:5e7, RANK:1 },
        ],
      },
    },
    {
      result:{
        data:[
          { OPERATEDEPT_CODE:'901', OPERATEDEPT_NAME:'机构专用', BUY:0, SELL:2e7, NET:-2e7, RANK:1 },
          { OPERATEDEPT_CODE:'902', OPERATEDEPT_NAME:'某游资营业部', BUY:0, SELL:1.5e7, NET:-1.5e7, RANK:2 },
        ],
      },
    }
  );

  assert.equal(seats.buySeats.length, 2);
  assert.equal(seats.buySeats[0].isInstitution, true);
  assert.equal(seats.buySeats[1].isNorthbound, true);
  assert.deepEqual(seats.institutionSummary, {
    buyCount:1,
    sellCount:1,
    buyAmount:5e7,
    sellAmount:2e7,
    netAmount:3e7,
  });
});

test('normalizes LHB institution summary, margin market series, and margin stock rankings', () => {
  const inst = normalizeLhbInstitutionPayload({
    result:{
      data:[
        { SECURITY_CODE:'300750', SECUCODE:'300750.SZ', SECURITY_NAME_ABBR:'宁德时代', TRADE_DATE:'2026-11-24', CLOSE_PRICE:245, CHANGE_RATE:6.5, BUY_AMT:2e8, SELL_AMT:0.5e8, NET_BUY_AMT:1.5e8, BUY_TIMES:3, SELL_TIMES:1, EXPLANATION:'机构净买' },
      ],
    },
  });
  assert.equal(inst.total, 1);
  assert.equal(inst.data[0].buyOrgCount, 3);
  assert.equal(inst.data[0].netAmount, 1.5e8);

  const market = normalizeMarginMarketPayload({
    result:{
      data:[
        { DIM_DATE:'2026-11-24 00:00:00', RZYE:1.82e12, RQYE:1.1e10, RZRQYE:1.831e12, RZMRE:1.2e11, RZCHE:1.1e11 },
        { DIM_DATE:'2026-11-21 00:00:00', RZYE:1.80e12, RQYE:1.0e10, RZRQYE:1.810e12, RZMRE:1.0e11, RZCHE:0.95e11 },
      ],
    },
  });
  assert.equal(market.latestDate, '2026-11-24');
  assert.equal(market.series.length, 2);
  assert.equal(market.latest.rzNetBuy, 1e10);
  assert.equal(market.latest.balanceDelta, 2.1e10);

  const stocks = normalizeMarginStocksPayload({
    result:{
      data:[
        { SCODE:'600519', SECNAME:'贵州茅台', DATE:'2026-11-24', SPJ:1520, ZDF:1.8, RZYE:2e10, RZMRE:8e8, RZCHE:5e8, RQYE:3e7 },
      ],
    },
  });
  assert.equal(stocks.tradeDate, '2026-11-24');
  assert.equal(stocks.data[0].symbol, 'sh600519');
  assert.equal(stocks.data[0].rzNetBuy, 3e8);
});

test('normalizes restricted share unlocks across legacy and new Eastmoney field names', () => {
  const result = normalizeUnlockPayload({
    result:{
      data:[
        {
          SECURITY_CODE:'600100', SECUCODE:'600100.SH', SECURITY_NAME_ABBR:'示例高解禁',
          FREE_DATE:'2026-11-28 00:00:00', FREE_SHARES_TYPE:'首发原股东限售股份',
          FREE_SHARES:50000000, ABLE_FREE_SHARES:45000000, LIFT_MARKET_CAP:2.5e9, TOTAL_RATIO:0.152,
        },
        {
          SECURITY_CODE:'000002', SECUCODE:'000002.SZ', SECURITY_NAME_ABBR:'示例小解禁',
          FREE_DATE:'2026-12-15 00:00:00', LIMITED_STOCK_TYPE:'股权激励限售股份',
          FREE_SHARES_NUM:1000000, LIFT_MARKET_CAP:1e7, FREE_RATIO:0.005,
        },
      ],
    },
  }, { todayKey:'2026-11-24' });

  assert.equal(result.total, 2);
  assert.equal(result.summary.next7DaysCount, 1);
  assert.equal(result.summary.highPressureCount, 1);
  assert.equal(result.summary.totalMarketCap, 2.51e9);
  assert.equal(result.data[0].totalRatioPct, 15.2);
  assert.equal(result.data[1].shareType, '股权激励限售股份');
  assert.equal(result.data[1].freeShares, 1000000);
});
