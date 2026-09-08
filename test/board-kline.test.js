'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function serverBoardKlineHelpers() {
  const start = serverSource.indexOf('function boardKlineNumber(value) {');
  const end = serverSource.indexOf('async function fetchBoardKlineRows', start);
  assert.ok(start >= 0 && end > start, 'board kline server helpers must exist in server.js');
  const context = { URLSearchParams };
  vm.createContext(context);
  return vm.runInContext(
    `${serverSource.slice(start, end)}\n;({ boardKlineNumber, normalizeBoardKlineRows, eastmoneyBoardKlineUrl });`,
    context
  );
}

test('normalizeBoardKlineRows parses Eastmoney kline strings and drops invalid rows', () => {
  const { normalizeBoardKlineRows } = serverBoardKlineHelpers();
  const rows = normalizeBoardKlineRows([
    '2026-09-07,3201.10,3198.55,3209.00,3190.01,12345678,4912345678.0,0.59,-0.21,-6.75,1.02',
    '2026-09-08 10:30,3200.00,3215.20,3220.10,3198.50,2345678,921000000.0,0.64,0.41,13.10,0.23',
    'not-a-kline-row',
    '2026-09-09,broken,3200.00,3201.00,3199.00,100,10,0.1,0.2,0.1,0.3',
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-09-07');
  assert.equal(rows[0].open, 3201.10);
  assert.equal(rows[0].close, 3198.55);
  assert.equal(rows[0].high, 3209.00);
  assert.equal(rows[0].low, 3190.01);
  assert.equal(rows[0].volume, 12345678);
  assert.equal(rows[0].amount, 4912345678.0);
  assert.equal(rows[0].amplitude, 0.59);
  assert.equal(rows[0].pct, -0.21);
  assert.equal(rows[0].change, -6.75);
  assert.equal(rows[0].turnover, 1.02);
  assert.equal(rows[1].date, '2026-09-08 10:30');
  assert.equal(rows[1].close, 3215.20);
});

test('boardKlineNumber treats upstream placeholders as null', () => {
  const { boardKlineNumber } = serverBoardKlineHelpers();
  assert.equal(boardKlineNumber('123.45'), 123.45);
  assert.equal(boardKlineNumber('-'), null);
  assert.equal(boardKlineNumber(''), null);
  assert.equal(boardKlineNumber(null), null);
});

test('eastmoneyBoardKlineUrl targets the board index secid 90.BKxxxx', () => {
  const { eastmoneyBoardKlineUrl } = serverBoardKlineHelpers();
  const url = new URL(eastmoneyBoardKlineUrl({ code:'BK1515', period:'101', limit:320, host:'https://push2his.eastmoney.com' }));
  assert.equal(url.hostname, 'push2his.eastmoney.com');
  assert.equal(url.searchParams.get('secid'), '90.BK1515');
  assert.equal(url.searchParams.get('klt'), '101');
  assert.equal(url.searchParams.get('lmt'), '320');
});

test('board K-line entry point and canvas are present in the main browser script', () => {
  assert.ok(html.includes('function openBoardKline('), 'openBoardKline must be defined in index.html');
  assert.ok(html.includes('id="board-kline-canvas"'), 'board K-line canvas must exist in index.html');
  assert.ok(html.includes('/api/board-kline'), 'frontend must call the board kline proxy route');
  assert.ok(html.includes('class="board-list-kline"'), 'board list rows must expose a quick K-line entry');
  assert.ok(html.includes('function renderBoardKlineOverview('), 'board K-line modal must render a F10-style overview');
});
