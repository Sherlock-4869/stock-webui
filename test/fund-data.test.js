'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFundHoldings,
  parseFundNews,
  parseFundRanking,
  parseFundScript,
  parseFundSearch,
  safeEastmoneyUrl,
  symbolFromEastmoneyId,
} = require('../fund-data');

test('fund script parser extracts only structured allowlisted values', () => {
  const source = [
    '/* profile */var fS_name = "示例成长混合";var fS_code="123456";',
    '/* fee */var fund_sourceRate="1.50";var fund_Rate="0.15";var fund_minsg="10";',
    'var syl_1y="2.10";var syl_3y="5.20";var syl_6y="8.30";var syl_1n="12.40";',
    'var Data_netWorthTrend=[{"x":1000,"y":1,"equityReturn":0,"unitMoney":""},{"x":2000,"y":1.1,"equityReturn":10,"unitMoney":"每份派0.1元"}];',
    'var Data_ACWorthTrend=[[1000,1],[2000,1.2]];',
    'var Data_grandTotal=[{"name":"示例成长混合","data":[[1000,0],[2000,10]]}];',
    'var Data_fundSharesPositions=[[2000,82.3]];',
    'var Data_assetAllocation={"categories":["2026-06-30"],"series":[{"name":"股票占净比","data":[82.3]},{"name":"净资产","data":[25.6]}]};',
    'var Data_holderStructure={"categories":["2025-12-31"],"series":[{"name":"机构持有比例","data":[12.5]}]};',
    'var Data_buySedemption={"categories":["2026-06-30"],"series":[{"name":"期间申购","data":[3.2]}]};',
    'var Data_fluctuationScale={"categories":["2025-12-31","2026-06-30"],"series":[{"y":30,"mom":"-1%"},{"y":25.6,"mom":"-14.67%"}]};',
    'var Data_performanceEvaluation={"avr":"72","categories":["收益率"],"data":[78]};',
    'var Data_currentFundManager=[{"id":"1","name":"张三","star":4,"workTime":"8年","fundSize":"20亿(2只基金)","power":{"avr":"80","categories":["经验值"],"data":[90]},"profit":{"categories":["任期收益"],"series":[{"data":[{"y":35.2}]}]}}];',
  ].join('');
  const parsed = parseFundScript(source);
  assert.equal(parsed.code, '123456');
  assert.equal(parsed.name, '示例成长混合');
  assert.equal(parsed.netWorth.length, 2);
  assert.equal(parsed.netWorth[1].distribution, '每份派0.1元');
  assert.equal(parsed.allocation['股票占净比'], 82.3);
  assert.equal(parsed.scale.value, 25.6);
  assert.equal(parsed.scale.change, '-14.67%');
  assert.equal(parsed.managers[0].name, '张三');
  assert.equal(parsed.managers[0].profit[0].value, 35.2);
});

test('fund ranking and search parsers normalize public payloads', () => {
  const ranking = parseFundRanking('var rankData = {datas:["123456,示例基金,SLJJ,2026-08-13,1.2345,2.3456,1.2,2.3,3.4,4.5,5.6,6.7,7.8,8.9,9.1,10.2,2020-01-01,1,20.1,1.50%,0.15%,1"],allRecords:1,allNum:1,zs_count:0,gp_count:1,hh_count:0,zq_count:0,qdii_count:0,fof_count:0};', 'stock');
  assert.equal(ranking.data[0].code, '123456');
  assert.equal(ranking.data[0].returns.daily, 1.2);
  assert.equal(ranking.data[0].returns.week, 2.3);
  assert.equal(ranking.data[0].returns.month, 3.4);
  assert.equal(ranking.data[0].returns.year, 6.7);
  assert.equal(ranking.data[0].currentRate, 0.15);
  assert.equal(ranking.counts.stock, 1);

  const search = parseFundSearch({ Datas:[{ CODE:'123456', NAME:'示例基金', JP:'SLJJ', FundBaseInfo:{ FTYPE:'混合型', JJGS:'示例基金公司', JJJL:'张三', FSRQ:'2026-08-13', DWJZ:1.2, ISBUY:'1', MINSG:10 } }] });
  assert.deepEqual(search[0], {
    code:'123456', name:'示例基金', pinyin:'SLJJ', type:'混合型', company:'示例基金公司', manager:'张三',
    navDate:'2026-08-13', unitNav:1.2, purchasable:true, minimum:10,
  });
});

test('fund holdings map A-share and Hong Kong identifiers without trusting upstream HTML', () => {
  const source = `var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4><table><tbody>
    <tr><td>1</td><td><a href='//quote.eastmoney.com/unify/r/1.600519'>600519</a></td><td>贵州茅台</td><td></td><td></td><td>资讯</td><td>6.50%</td><td>12.34</td><td>18,000.50</td></tr>
    <tr><td>2</td><td><a href='//quote.eastmoney.com/unify/r/116.00700'>00700</a></td><td>腾讯控股</td><td></td><td></td><td>资讯</td><td>5.20%</td><td>8.00</td><td>9,000.00</td></tr>
  </tbody></table>"};`;
  const holdings = parseFundHoldings(source);
  assert.equal(holdings.date, '2026-06-30');
  assert.equal(holdings.data[0].symbol, 'sh600519');
  assert.equal(holdings.data[1].symbol, 'hk00700');
  assert.equal(holdings.totalRatio, 11.7);
  assert.equal(symbolFromEastmoneyId('0.000001'), 'sz000001');
  assert.equal(symbolFromEastmoneyId('evil'), '');
});

test('fund news keeps only HTTPS Eastmoney links', () => {
  const source = `<!-- 基金要闻 start --><ul>
    <li><a href="http://fund.eastmoney.com/a/1.html"><span class="newsTit">公开资讯</span><span class="newsData">08-14</span></a></li>
    <li><a href="javascript:alert(1)"><span class="newsTit">恶意链接</span></a></li>
  </ul><!-- 基金要闻 end --><!-- 基金公告 start --><ul><li><a href="https://fund.eastmoney.com/gonggao/1.html"><span class="newsTit">基金公告</span><span class="newsData">08-13</span></a></li></ul><!-- 基金公告 end -->`;
  const parsed = parseFundNews(source);
  assert.equal(parsed.news.length, 1);
  assert.equal(parsed.news[0].url, 'https://fund.eastmoney.com/a/1.html');
  assert.equal(parsed.announcements[0].title, '基金公告');
  assert.equal(safeEastmoneyUrl('https://evil.example/fake'), '');
});
