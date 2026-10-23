'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SINA_BOARD_NODES,
  SINA_FLOW_CATEGORIES,
  sinaBoardList,
  sinaBoardStocks,
  sinaFlowRanking,
} = require('../board-fallback');

test('Sina board list is decoded into the Eastmoney board row shape', () => {
  const payload = 'var S_Finance_bankuai_sinaindustry = '
    + JSON.stringify({
      new_blhy:'new_blhy,玻璃行业,19,13.975,-0.649,-4.4407,591907819,6854057972,sh600529,0.445,18.040,0.080,山东药玻',
    }) + ';';
  const result = sinaBoardList(payload, SINA_BOARD_NODES.industry.varName, { type:'industry', label:'行业板块' });
  assert.equal(result.source, 'sina');
  assert.equal(result.data.length, 1);
  const [board] = result.data;
  assert.equal(board.code, 'new_blhy');
  assert.equal(board.name, '玻璃行业');
  assert.equal(board.total, 19);
  assert.equal(board.pct, -4.4407);
  assert.equal(board.change, -0.649);
  assert.equal(board.leader.symbol, 'sh600529');
  assert.equal(board.leader.name, '山东药玻');
});

test('Sina constituents are mapped to the Eastmoney stock row shape', () => {
  const result = sinaBoardStocks([
    { symbol:'sh600529', code:'600529', name:'山东药玻', trade:'18.020', changepercent:0.334,
      pricechange:0.06, volume:3068554, amount:55052667, turnoverratio:0.4624,
      mktcap:1195832.631626, nmc:1195832.631626, pb:1.399 },
  ], { code:'BK0538' });
  assert.equal(result.source, 'sina');
  assert.equal(result.code, 'BK0538');
  const [stock] = result.stocks;
  assert.equal(stock.symbol, 'sh600529');
  assert.equal(stock.price, 18.02);
  assert.equal(stock.pct, 0.334);
  assert.equal(stock.mainNetInflow, null, 'Sina constituents carry no main-fund figure');
});

test('Sina flow ranking keeps the requested direction and scales ratios to percent', () => {
  const rows = [
    { category:'gn_rzrq', name:'融资融券', avg_price:'10.2973', avg_changeratio:'0.0001619',
      netamount:'5096603028.53', ratioamount:'0.0409653', turnover:'40.3766' },
    { category:'gn_jjzc', name:'基金重仓', avg_price:'8.1', avg_changeratio:'-0.01',
      netamount:'-1200000', ratioamount:'-0.002', turnover:'9' },
  ];
  const out = sinaFlowRanking(rows, { scope:'board', type:'concept', period:'today', direction:'out' });
  assert.equal(out.source, 'sina');
  assert.deepEqual(out.data.map(item => item.code), ['gn_jjzc', 'gn_rzrq'], 'outflow direction sorts ascending');
  assert.equal(out.data[1].mainNet, 5096603028.53);
  assert.equal(out.data[1].mainRatio.toFixed(3), '4.097');
  const inbound = sinaFlowRanking(rows, { scope:'board', type:'concept', period:'today', direction:'in' });
  assert.deepEqual(inbound.data.map(item => item.code), ['gn_rzrq', 'gn_jjzc']);
});

test('Sina flow categories match verified upstream numbering', () => {
  // Verified: fenlei=1 serves concept boards, fenlei=2 serves industry boards,
  // fenlei=3 returns index constituents rather than a board.
  assert.deepEqual(SINA_FLOW_CATEGORIES, { concept:'1', industry:'2' });
});