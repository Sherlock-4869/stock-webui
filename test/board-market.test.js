'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function boardMarketHelpers() {
  const start = serverSource.indexOf('const EASTMONEY_BOARD_HOSTS');
  const end = serverSource.indexOf('async function fetchEastmoneyBoardRows', start);
  assert.ok(start >= 0 && end > start, 'board market URL helper must exist in server.js');
  const context = { URLSearchParams };
  vm.createContext(context);
  return vm.runInContext(
    `const EASTMONEY_PUBLIC_QUOTE_TOKEN = 'bd1d9ddb04089700cf9c27f6f7426281';\n${serverSource.slice(start, end)}\n;({ eastmoneyBoardUrl });`,
    context,
  );
}

test('board market requests include Eastmoney public quote token', () => {
  const { eastmoneyBoardUrl } = boardMarketHelpers();
  const url = new URL(eastmoneyBoardUrl({
    fs:'m:90+t:2+f:!50',
    fields:'f2,f3,f12,f14',
    pageSize:100,
  }));
  assert.equal(url.searchParams.get('ut'), 'bd1d9ddb04089700cf9c27f6f7426281');
  assert.equal(url.searchParams.get('fs'), 'm:90+t:2+f:!50');
});
