'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  weekRange,
  selectWeekIpos,
  selectDailyIpos,
  formatBoard,
  buildWeeklyMessage,
  buildDailyMessage,
  zonedParts,
} = require('../wechat/weekly-ipo');
const { parseWechatXml, textReplyXml } = require('../wechat/xml');
const { buildDefaultMenu, signatureFor } = require('../wechat/service');
const { loadWechatConfig } = require('../wechat/config');

test('weekRange uses Monday through Sunday in Shanghai', () => {
  const range = weekRange(new Date('2026-07-27T01:00:00Z'), 'Asia/Shanghai');
  assert.equal(range.start, '2026-07-27');
  assert.equal(range.end, '2026-08-02');
  assert.equal(range.local.weekday, 1);
  assert.equal(range.local.hour, 9);
});

test('weekRange handles Sunday near UTC boundary', () => {
  const range = weekRange(new Date('2026-08-02T16:30:00Z'), 'Asia/Shanghai');
  assert.equal(range.start, '2026-08-03');
  assert.equal(range.end, '2026-08-09');
  assert.equal(zonedParts(new Date('2026-08-02T16:30:00Z'), 'Asia/Shanghai').weekday, 1);
});

test('selectWeekIpos filters and orders by apply date', () => {
  const range = { start: '2026-07-27', end: '2026-08-02' };
  const rows = [
    { code: '3', applyDate: '2026-08-03 00:00:00' },
    { code: '2', applyDate: '2026-07-31 00:00:00' },
    { code: '1', applyDate: '2026-07-27 00:00:00' },
  ];
  assert.deepEqual(selectWeekIpos(rows, range).map(item => item.code), ['1', '2']);
});

test('weekly message contains IPO details and target page', () => {
  const content = buildWeeklyMessage([
    { name: '测试股份', applyCode: '787001', applyDate: '2026-07-28', price: 12.5, board: '科创板' },
  ], { start: '2026-07-27', end: '2026-08-02' }, 'https://stock.example/?page=ipo');
  assert.match(content, /测试股份/);
  assert.match(content, /测试股份（787001）【科创板】/);
  assert.match(content, /12\.50元/);
  assert.match(content, /https:\/\/stock\.example\/\?page=ipo/);
});

test('IPO messages label each stock board', () => {
  const items = [
    { name: '创业测试', code: '301001', applyDate: '2026-07-28', price: 10 },
    { name: '科创测试', code: '688001', applyDate: '2026-07-28', price: 11 },
    { name: '沪市测试', code: '603001', applyDate: '2026-07-28', price: 12 },
    { name: '深市测试', code: '001001', applyDate: '2026-07-28', price: 13 },
    { name: '北交测试', code: '920001', applyDate: '2026-07-28', price: 14 },
  ];
  const weekly = buildWeeklyMessage(items, { start: '2026-07-27', end: '2026-08-02' }, 'https://stock.example/?page=ipo');
  assert.match(weekly, /创业测试（301001）【创业板】/);
  assert.match(weekly, /科创测试（688001）【科创板】/);
  assert.match(weekly, /沪市测试（603001）【沪市主板】/);
  assert.match(weekly, /深市测试（001001）【深市主板】/);
  assert.match(weekly, /北交测试（920001）【北交所】/);
  const daily = buildDailyMessage(items, '2026-07-28', 'https://stock.example/?page=ipo');
  assert.match(daily, /创业测试（301001）【创业板】/);
});

test('daily IPO selection only includes the requested subscription date', () => {
  const rows = [
    { code: '3', applyDate: '2026-07-31 00:00:00' },
    { code: '2', applyDate: '2026-07-30 09:30:00' },
    { code: '1', applyDate: '2026-07-30' },
  ];
  assert.deepEqual(selectDailyIpos(rows, '2026-07-30').map(item => item.code), ['1', '2']);
});

test('daily message contains today IPO details and target page', () => {
  const content = buildDailyMessage([
    { name: '今日股份', applyCode: '787002', applyDate: '2026-07-30', price: 8.25, board: '科创板' },
  ], '2026-07-30', 'https://stock.example/?page=ipo');
  assert.match(content, /今日新股申购提醒/);
  assert.match(content, /2026-07-30 周四/);
  assert.match(content, /今日股份/);
  assert.match(content, /8\.25元/);
  assert.match(content, /https:\/\/stock\.example\/\?page=ipo/);
});

test('IPO board falls back to stock code and exchange', () => {
  assert.equal(formatBoard({ code: '688001' }), '科创板');
  assert.equal(formatBoard({ code: '301001' }), '创业板');
  assert.equal(formatBoard({ code: '920001' }), '北交所');
  assert.equal(formatBoard({ code: '603001' }), '沪市主板');
  assert.equal(formatBoard({ code: '001001' }), '深市主板');
  assert.equal(formatBoard({ market: '上海证券交易所' }), '沪市主板');
  assert.equal(formatBoard({ board: '创业板' }), '创业板');
  assert.equal(formatBoard({ board: '上海证券交易所主板' }), '沪市主板');
});

test('default WeChat menu connects click actions and IPO page', () => {
  const menu = buildDefaultMenu('https://stock.example/?page=ipo');
  assert.equal(menu.button.length, 2);
  assert.deepEqual(menu.button[0].sub_button.map(item => item.key), [
    'IPO_WEEKLY', 'IPO_ENABLE', 'IPO_DISABLE',
  ]);
  assert.deepEqual(menu.button[1], {
    type: 'view',
    name: '打新日历',
    url: 'https://stock.example/?page=ipo',
  });
});

test('weekly message explicitly reports an empty week', () => {
  const content = buildWeeklyMessage([], { start: '2026-07-27', end: '2026-08-02' }, 'https://stock.example/?page=ipo');
  assert.match(content, /本周暂无可申购新股/);
});

test('callback XML parser and text reply handle standard WeChat XML', () => {
  const message = parseWechatXml(`<xml>
    <ToUserName><![CDATA[gh_test]]></ToUserName>
    <FromUserName><![CDATA[openid_test]]></FromUserName>
    <CreateTime>123</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[本周打新]]></Content>
  </xml>`);
  assert.equal(message.FromUserName, 'openid_test');
  assert.equal(message.Content, '本周打新');
  const reply = textReplyXml(message, 'A&B <test>');
  assert.match(reply, /<ToUserName><!\[CDATA\[openid_test\]\]><\/ToUserName>/);
  assert.match(reply, /A&amp;B &lt;test&gt;/);
});

test('callback signature follows WeChat SHA1 sorting rule', () => {
  assert.equal(signatureFor('token', '123', 'nonce'), '2281069218034965b5452f066243552ce6594a04');
});

test('configuration never requires secrets while integration is disabled', () => {
  const disabled = loadWechatConfig({});
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.missing, []);
  const enabled = loadWechatConfig({ STOCK_WECHAT_ENABLED: 'true' });
  assert.ok(enabled.missing.includes('STOCK_WECHAT_APP_SECRET'));
  assert.ok(enabled.missing.includes('STOCK_DB_PASSWORD'));
});

test('daily IPO notification is enabled by default and can be configured', () => {
  const defaults = loadWechatConfig({});
  assert.equal(defaults.dailyIpoEnabled, true);
  assert.equal(defaults.dailyIpoHour, 9);
  assert.equal(defaults.dailyIpoMinute, 0);
  const configured = loadWechatConfig({
    STOCK_WECHAT_DAILY_IPO_ENABLED: 'false',
    STOCK_WECHAT_DAILY_IPO_HOUR: '8',
    STOCK_WECHAT_DAILY_IPO_MINUTE: '45',
  });
  assert.equal(configured.dailyIpoEnabled, false);
  assert.equal(configured.dailyIpoHour, 8);
  assert.equal(configured.dailyIpoMinute, 45);
});
