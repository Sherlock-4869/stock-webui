'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { weekRange, selectWeekIpos, buildWeeklyMessage, zonedParts } = require('../wechat/weekly-ipo');
const { parseWechatXml, textReplyXml } = require('../wechat/xml');
const { signatureFor } = require('../wechat/service');
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
    { name: '测试股份', applyCode: '787001', applyDate: '2026-07-28', price: 12.5 },
  ], { start: '2026-07-27', end: '2026-08-02' }, 'https://stock.example/?page=ipo');
  assert.match(content, /测试股份/);
  assert.match(content, /12\.50元/);
  assert.match(content, /https:\/\/stock\.example\/\?page=ipo/);
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
