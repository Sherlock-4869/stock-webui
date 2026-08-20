'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCffexFuture,
  parseEastmoneyFastNews,
  parseFuturesFlashHtml,
  parseSinaGlobalFutures,
  parseSinaSpotIndexes,
} = require('../derivatives-market');

test('parses stock index futures, spot indexes, basis and US overnight futures', () => {
  const spots = parseSinaSpotIndexes('var hq_str_s_sh000300="沪深300,4000.00,20.00,0.50,1,2";');
  const future = normalizeCffexFuture({
    symbol:'IF0', trade:'3980', prevsettlement:'3960', open:'3970', high:'3990', low:'3950',
    volume:'120', position:'300', tradedate:'2026-08-20', ticktime:'15:00:00',
  }, spots.IF);
  assert.equal(future.price, 3980);
  assert.equal(future.pct, 20 / 3960 * 100);
  assert.equal(future.basis, -20);
  assert.equal(future.basisPct, -.5);

  const rows = parseSinaGlobalFutures('var hq_str_hf_ES="5100,,5100.25,5100.5,5120,5070,21:00:01,5050,5080,123,0,0,2026-08-20,标普500指数期货,0";');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'ES');
  assert.equal(rows[0].change, 50);
  assert.equal(rows[0].pct, 50 / 5050 * 100);
});

test('parses futures flashes and filters global stock news to safe US-related links', () => {
  const flashes = parseFuturesFlashHtml('<a class="list red" href="https://qhweb.eastmoney.com/news/123.html"><div class="time">15:20</div><div class="title">【期市收评】&amp; 股指期货</div></a>');
  assert.deepEqual(flashes, [{ title:'【期市收评】& 股指期货', time:'15:20', url:'https://qhweb.eastmoney.com/news/123.html', important:true }]);

  const source = `var ajaxResult=${JSON.stringify({ LivesList:[
    { title:'美股盘前走高', digest:'纳指期货上涨', showtime:'2026-08-20 20:00:00', url_m:'https://wap.eastmoney.com/a/1.html' },
    { title:'其他新闻', digest:'无关', showtime:'2026-08-20 19:00:00', url_m:'https://wap.eastmoney.com/a/2.html' },
    { title:'恶意链接', digest:'美股', url_m:'javascript:alert(1)' },
  ]})};`;
  const news = parseEastmoneyFastNews(source, { keywords:['美股','纳指'] });
  assert.equal(news.length, 1);
  assert.equal(news[0].title, '美股盘前走高');
});
