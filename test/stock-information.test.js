'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAnnouncementPayload,
  normalizeFinancialPayload,
  parseSinaStockNews,
  safeSinaNewsUrl,
} = require('../stock-information');

test('announcement payload keeps matching A-share disclosures and safe public PDF links', () => {
  const rows = normalizeAnnouncementPayload({ success:1, data:{ list:[
    {
      art_code:'AN202608141827992716',
      codes:[{ stock_code:'000001', short_name:'平安银行' }],
      columns:[{ column_name:'半年度报告全文' }],
      display_time:'2026-08-14 19:21:17:353',
      title:'平安银行:2026年半年度报告',
    },
    {
      art_code:'AN202608141827992717',
      codes:[{ stock_code:'600519', short_name:'贵州茅台' }],
      columns:[{ column_name:'其他' }],
      title:'贵州茅台:不属于目标股票',
    },
  ] } }, 'sz000001');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id:'AN202608141827992716',
    title:'2026年半年度报告',
    kind:'定期报告',
    publishedAt:'2026-08-14 19:21:17',
    url:'https://np-snotice.eastmoney.com/pdf/H3_AN202608141827992716_1.pdf',
    source:'东方财富公开公告页',
    isReport:true,
    important:false,
  });
});

test('financial payload normalizes recent reports and removes duplicate report dates', () => {
  const periods = normalizeFinancialPayload({ result:{ data:[
    {
      SECUCODE:'600519.SH', REPORT_DATE:'2026-06-30 00:00:00', REPORT_DATE_NAME:'2026中报', NOTICE_DATE:'2026-08-15',
      TOTALOPERATEREVE:92278072083.21, PARENTNETPROFIT:44516880421.86, TOTALOPERATEREVETZ:1.3,
      PARENTNETPROFITTZ:-1.95, EPSJB:35.57, BPS:200.99, MGJYXJJE:56.55, ROEJQ:16.75, XSMLL:89.56,
    },
    { SECUCODE:'600519.SH', REPORT_DATE:'2026-06-30 00:00:00', REPORT_DATE_NAME:'修订稿' },
    { SECUCODE:'000001.SZ', REPORT_DATE:'2026-06-30 00:00:00', REPORT_DATE_NAME:'其他股票' },
  ] } }, 'sh600519');
  assert.equal(periods.length, 1);
  assert.equal(periods[0].reportName, '2026中报');
  assert.equal(periods[0].revenue, 92278072083.21);
  assert.equal(periods[0].netProfitGrowth, -1.95);
  assert.equal(periods[0].operatingCashFlowPerShare, 56.55);
});

test('Sina stock news parser keeps only allowlisted HTTPS links and deduplicates titles', () => {
  const html = `<div class="datelist"><ul>
    2026-08-20&nbsp;17:05&nbsp;&nbsp;<a target="_blank" href="http://finance.sina.com.cn/roll/a.shtml">公司发布经营动态</a><br>
    2026-08-20&nbsp;17:04&nbsp;&nbsp;<a href="https://finance.sina.com.cn/roll/b.shtml">公司发布经营动态</a><br>
    2026-08-20&nbsp;16:00&nbsp;&nbsp;<a href="javascript:alert(1)">恶意链接</a><br>
    2026-08-20&nbsp;15:00&nbsp;&nbsp;<a href="https://stock.finance.sina.com.cn/report">某券商维持买入评级</a>
  </ul></div>`;
  const rows = parseSinaStockNews(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://finance.sina.com.cn/roll/a.shtml');
  assert.equal(rows[0].publishedAt, '2026-08-20 17:05:00');
  assert.equal(rows[1].kind, '研报观点');
  assert.equal(safeSinaNewsUrl('https://evil.example/a'), '');
});
