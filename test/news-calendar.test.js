'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildUpcomingMacroSchedule,
  normalizeDividendCalendarPayload,
  normalizeEarningsCalendarPayload,
  parseNewsFlashPayload,
  safeEastmoneyHttpsUrl,
} = require('../news-calendar');

test('parses 7x24 news flash, strips unsafe HTML, allowlists Eastmoney HTTPS URLs and extracts stock codes', () => {
  assert.equal(safeEastmoneyHttpsUrl('http://finance.eastmoney.com/a/20261124.html'), 'https://finance.eastmoney.com/a/20261124.html');
  assert.equal(safeEastmoneyHttpsUrl('https://evil.example.com/eastmoney.com'), '');
  assert.equal(safeEastmoneyHttpsUrl('javascript:alert(1)'), '');

  const raw = 'var ajaxResult=' + JSON.stringify({
    LivesList: [
      {
        id: '1001',
        title: '<b>央行开展逆回购操作</b>',
        digest: '央行今日释放流动性，贵州茅台(600519)盘中活跃',
        showtime: '2026-11-24 09:30:10',
        url_w: 'http://finance.eastmoney.com/a/202611241.html',
      },
      {
        id: '1001',
        title: '重复条目',
        digest: '应当按 id 去重',
        showtime: '2026-11-24 09:30:10',
      },
      {
        id: '1002',
        title: '常规行业沟通纪要',
        digest: '日常交流动态',
        showtime: '2026-11-24 09:28:00',
        url_w: 'https://malicious.test/phish',
        stockList: [{ code: '300750.SZ' }],
      },
    ],
  }) + ';';

  const items = parseNewsFlashPayload(raw, { channel: 'all' });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '央行开展逆回购操作');
  assert.equal(items[0].important, true);
  assert.equal(items[0].url, 'https://finance.eastmoney.com/a/202611241.html');
  assert.deepEqual(items[0].stocks, [{ code: '600519', symbol: 'sh600519' }]);
  assert.equal(items[1].url, '');
  assert.deepEqual(items[1].stocks, [{ code: '300750', symbol: 'sz300750' }]);
});

test('builds macro schedule within requested date window and avoids weekend LPR/PMI collisions', () => {
  const events = buildUpcomingMacroSchedule('2026-11-20', 35);
  assert.ok(events.length >= 4);
  for (const event of events) {
    assert.ok(event.date >= '2026-11-20' && event.date <= '2026-12-25');
    const day = new Date(`${event.date}T00:00:00Z`).getUTCDay();
    assert.notEqual(day, 0, `${event.title} should not land on Sunday`);
    assert.notEqual(day, 6, `${event.title} should not land on Saturday`);
  }
  assert.ok(events.some(e => e.title.includes('LPR')));
  assert.ok(events.some(e => e.title.includes('PMI')));
  assert.ok(events.some(e => e.title.includes('非农')));
});

test('normalizes earnings appointment and ex-dividend schedules cleanly', () => {
  const earnings = normalizeEarningsCalendarPayload({
    result: {
      data: [
        { SECURITY_CODE: '600519', SECUCODE: '600519.SH', SECURITY_NAME_ABBR: '贵州茅台', APPOINT_PUBLISH_DATE: '2026-11-28 00:00:00', REPORT_TYPE_NAME: '2026年三季报' },
        { SECURITY_CODE: '600519', SECUCODE: '600519.SH', SECURITY_NAME_ABBR: '贵州茅台', APPOINT_PUBLISH_DATE: '2026-11-28 00:00:00', REPORT_TYPE_NAME: '2026年三季报' },
      ],
    },
  });
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0].symbol, 'sh600519');
  assert.equal(earnings[0].date, '2026-11-28');

  const dividends = normalizeDividendCalendarPayload({
    result: {
      data: [
        { SECURITY_CODE: '000001', SECUCODE: '000001.SZ', SECURITY_NAME_ABBR: '平安银行', EX_DIVIDEND_DATE: '2026-12-02 00:00:00', PRETAX_BONUS_RMB: 2.85, RZR_GR_RATE: 2 },
      ],
    },
  });
  assert.equal(dividends.length, 1);
  assert.equal(dividends[0].symbol, 'sz000001');
  assert.match(dividends[0].planText, /10转2股派2\.85元/);
});
