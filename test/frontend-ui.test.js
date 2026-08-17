'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const floatHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'float.html'), 'utf8');
const pipHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'pip.html'), 'utf8');
const referenceHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'reference.html'), 'utf8');
const referenceReaderScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'reference-reader.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('main browser script parses as JavaScript', () => {
  const scriptStart = html.indexOf('<script>\nconst STORAGE_KEY');
  const scriptEnd = html.lastIndexOf('</script>');
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'main browser script must be present');
  const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
  assert.doesNotThrow(() => new Function(script));
});

test('standalone quote windows parse as JavaScript', () => {
  for (const source of [floatHtml, pipHtml]) {
    const scriptStart = source.lastIndexOf('<script>');
    const scriptEnd = source.lastIndexOf('</script>');
    assert.ok(scriptStart >= 0 && scriptEnd > scriptStart);
    assert.doesNotThrow(() => new Function(source.slice(scriptStart + '<script>'.length, scriptEnd)));
  }
});

function markdownFunctions() {
  const start = html.indexOf('function safeMarkdownUrl');
  const end = html.indexOf('function updateNotePreview', start);
  assert.ok(start >= 0 && end > start, 'Markdown functions must exist in index.html');
  const context = {
    escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    },
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('Markdown heading navigation ignores fenced code and matches preview anchors', () => {
  const { extractMarkdownHeadings, renderMarkdown } = markdownFunctions();
  const markdown = [
    '# 总览',
    '```md',
    '# 代码里的伪标题',
    '```',
    '## 交易计划',
    '### 风险提示',
  ].join('\n');

  const headings = JSON.parse(JSON.stringify(extractMarkdownHeadings(markdown)));
  assert.deepEqual(headings, [
    { level: 1, text: '总览', id: 'note-heading-0' },
    { level: 2, text: '交易计划', id: 'note-heading-1' },
    { level: 3, text: '风险提示', id: 'note-heading-2' },
  ]);

  const preview = renderMarkdown(markdown);
  assert.match(preview, /<h1 id="note-heading-0">总览<\/h1>/);
  assert.match(preview, /<h2 id="note-heading-1">交易计划<\/h2>/);
  assert.match(preview, /<h3 id="note-heading-2">风险提示<\/h3>/);
  assert.match(preview, /<pre><code class="lang-md"># 代码里的伪标题/);
  assert.doesNotMatch(preview, /id="note-heading-3"/);
});

test('notes keep file and heading navigation in fixed sidebar tabs with folder controls', () => {
  assert.match(html, /\.note-sidebar\{position:sticky;top:66px/);
  assert.match(html, /\.note-toolbar\{position:sticky;z-index:25;top:66px/);
  assert.match(html, /id="note-files-tab"[^>]*role="tab"[^>]*>文件列表<\/button>/);
  assert.match(html, /id="note-headings-tab"[^>]*role="tab"[^>]*>标题导航<\/button>/);
  assert.match(html, /id="note-toc-list"[^>]*aria-label="当前笔记标题导航"/);
  assert.match(html, /id="note-folder-list"/);
  assert.match(html, /onclick="createNoteFolder\(\)"/);
  assert.match(html, /id="note-create-folder-select"[^>]*onchange="setNoteCreateFolder\(this\.value\)"/);
  assert.match(html, />新建\/导入到<select/);
  assert.match(html, /id="note-folder-select"[^>]*onchange="moveCurrentNoteToFolder\(this\.value\)"/);
  assert.match(html, />归类到<select/);
  assert.match(html, /async function createNoteFolder\(\)/);
  assert.match(html, /async function renameNoteFolder\(folderId\)/);
  assert.match(html, /async function deleteNoteFolder\(folderId\)/);
  assert.match(html, /笔记会移到“未分类”，不会被删除/);
  assert.doesNotMatch(html, /note-toc-popover|toggleNoteToc/);
});

test('brand navigation returns home without reloading the current application', () => {
  assert.match(html, /class="app-brand"[^>]*href="\/"[^>]*onclick="handleAppBrandClick\(event\)"/);
  const start = html.indexOf('function handleAppBrandClick');
  const end = html.indexOf('async function loadReferenceDocument', start);
  assert.ok(start >= 0 && end > start);
  const pages = [];
  const context = { switchAppPage:page => pages.push(page) };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  let prevented = false;
  context.handleAppBrandClick({ button:0, metaKey:false, ctrlKey:false, shiftKey:false, altKey:false, preventDefault:() => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(pages, ['market']);

  prevented = false;
  context.handleAppBrandClick({ button:0, metaKey:true, ctrlKey:false, shiftKey:false, altKey:false, preventDefault:() => { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(pages, ['market']);
});

test('note heading navigation scrolls the selected preview heading into view', () => {
  const start = html.indexOf('function jumpToNoteHeading');
  const end = html.indexOf('function setNoteView', start);
  assert.ok(start >= 0 && end > start);
  let selector = '';
  let scrollOptions = null;
  const heading = { scrollIntoView:options => { scrollOptions = options; } };
  const preview = { querySelector:value => { selector = value; return heading; } };
  const context = {
    noteViewMode:'split',
    document:{ getElementById:id => id === 'note-preview' ? preview : null },
    setNoteView() {},
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.jumpToNoteHeading('note-heading-2');
  assert.equal(selector, '[id="note-heading-2"]');
  assert.deepEqual(JSON.parse(JSON.stringify(scrollOptions)), { behavior:'smooth', block:'start', inline:'nearest' });
});

test('sidebar groups navigation and supports collapse on desktop plus overlay on mobile', () => {
  const navStart = html.indexOf('<div class="app-nav-inner">');
  const navEnd = html.indexOf('</nav>', navStart);
  const nav = html.slice(navStart, navEnd);
  const referenceIndex = nav.indexOf('data-page="reference"');
  const chatIndex = nav.indexOf('id="chat-entry-btn"');
  const researchGroup = nav.indexOf('id="sidebar-group-research"');
  const aiGroup = nav.indexOf('id="sidebar-group-ai"');
  const communityGroup = nav.indexOf('id="sidebar-group-community"');
  assert.ok(referenceIndex > researchGroup);
  assert.ok(nav.indexOf('id="ai-entry-btn"') > aiGroup);
  assert.ok(nav.indexOf('id="user-ai-models-entry"') > aiGroup);
  assert.ok(chatIndex > communityGroup);
  assert.ok(nav.indexOf('class="sidebar-collapse"') < nav.indexOf('<div class="sidebar-scroll">'));
  assert.match(nav, /id="admin-navigation" hidden/);
  assert.match(nav, /<svg class="app-tab-icon"/);
  assert.doesNotMatch(nav, /<span class="app-tab-icon">/);
  assert.match(html, /class="sidebar-mobile-icon"/);
  assert.match(html, /SIDEBAR_COLLAPSED_STORAGE_KEY/);
  assert.match(html, /function toggleSidebar\(\)/);
  assert.match(html, /body\.sidebar-collapsed/);
  assert.match(html, /@media\(max-width:860px\).*sidebar-open/s);
  assert.match(html, /id="sidebar-mobile-toggle"/);
  assert.match(html, /id="sidebar-hover-label" role="tooltip"/);
  assert.match(html, /item\.addEventListener\('pointerenter', showTooltip\)/);
  assert.match(html, /item\.removeAttribute\('title'\)/);
  assert.match(html, /body\.sidebar-collapsed \.account-trigger\{width:48px;height:48px/);
  assert.match(html, /<section class="app-page" id="page-reference">/);
  assert.match(html, /href="\/reference\.html" target="_blank" rel="noopener noreferrer"/);
});

test('site recommendations open a searchable right-side directory with safe new-tab links', () => {
  assert.match(html, /data-page="sites"[^>]*onclick="switchAppPage\('sites'\)"/);
  assert.match(html, /id="site-recommendations"[^>]*onmouseenter="showSiteRecommendationsPreview\(\)"/);
  assert.match(html, /id="site-recommendation-menu"[^>]*aria-label="推荐站点预览"/);
  assert.match(html, /function renderSiteRecommendationsPreview\(\)/);
  assert.match(html, /function positionSiteRecommendationsPreview\(\)/);
  assert.match(html, /site-recommendation-menu,body\.sidebar-collapsed \.site-recommendation-menu\{position:fixed/);
  assert.match(html, /document\.body\.appendChild\(siteMenu\)/);
  assert.match(html, /body\{overflow-x:clip\}/);
  assert.match(html, /\.app-nav:has\(#site-recommendations:hover\)/);
  assert.match(html, /id="page-sites"/);
  assert.match(html, /id="site-directory-search"[^>]*oninput="filterSiteDirectory\(\)"/);
  assert.match(html, /id="site-directory-grid"/);
  assert.match(html, /\.site-directory-grid\{display:grid/);
  assert.match(html, /apiRequest\('\/api\/site-recommendations'/);
  assert.match(html, /link\.target = '_blank'/);
  assert.match(html, /link\.rel = 'noopener noreferrer'/);

  const start = html.indexOf('function safeRecommendedSiteUrl');
  const end = html.indexOf('function renderSiteDirectory', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.safeRecommendedSiteUrl('https://pro.momoyu.cc'), 'https://pro.momoyu.cc/');
  assert.equal(context.safeRecommendedSiteUrl('javascript:alert(1)'), '');
  assert.equal(context.safeRecommendedSiteUrl('/relative'), '');
});

test('reference reader escapes source HTML and generates stable unique anchors', () => {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(referenceReaderScript, context);

  const rendered = context.ReferenceReader.renderMarkdown([
    '# <script>alert(1)</script>',
    '## 重复标题',
    '## 重复标题',
    '正文 <img src=x onerror=alert(1)>',
  ].join('\n'));

  assert.doesNotMatch(rendered, /<script>|<img/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /id="reference-重复标题"/);
  assert.match(rendered, /id="reference-重复标题-2"/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('standalone and in-page reference views share the same renderer', () => {
  assert.match(html, /<script src="\/reference-reader\.js"><\/script>/);
  assert.match(referenceHtml, /<script src="\/reference-reader\.js"><\/script>/);
  assert.match(referenceHtml, /ReferenceReader\.mount\(\{article:'document',toc:'toc-links'\}\)/);
  assert.doesNotMatch(referenceHtml, /function renderMarkdown/);
});

test('all app pages support direct URL navigation and browser history', () => {
  assert.match(html, /const APP_PAGES = \['market','boards','funds','ipo','alerts','notes','reference','sites','ai','user-ai-models','admin-users','admin-sites','admin-ai'\]/);
  assert.match(html, /document\.title = '深度学习';/);
  assert.doesNotMatch(html, /APP_PAGE_TITLES/);
  assert.match(html, /history\.pushState\(\{ page \}, '', url\)/);
  assert.match(html, /addEventListener\('popstate'/);
  assert.match(html, /aria-current/);
});

test('board market page exposes sector categories, rankings, and stock drill-down', () => {
  assert.match(html, /data-page="boards"[^>]*onclick="switchAppPage\('boards'\)"/);
  assert.match(html, /id="page-boards"/);
  assert.match(html, /data-board-type="industry"/);
  assert.match(html, /data-board-type="concept"/);
  assert.match(html, /data-board-type="region"/);
  assert.match(html, /涨幅前十/);
  assert.match(html, /跌幅前十/);
  assert.match(html, /资金流入前五/);
  assert.match(html, /function openBoardStock\(symbol\)/);
  assert.match(html, /function openStockBoard\(board\)/);
  assert.match(html, /async function stockBoardExists\(board, type\)/);
  assert.match(html, /function openStockBoardByIndex\(index\)/);
  assert.match(html, /stock-board-tag clickable/);
  const stockBoardJumpStart = html.indexOf('async function openStockBoard(board)');
  const stockBoardJumpEnd = html.indexOf('function openStockBoardByIndex', stockBoardJumpStart);
  assert.match(html.slice(stockBoardJumpStart, stockBoardJumpEnd), /search\.value = board\.name; filterBoardList\(\)/);
  assert.match(html.slice(stockBoardJumpStart, stockBoardJumpEnd), /const exists = await stockBoardExists\(board, targetType\)/);
  assert.match(html.slice(stockBoardJumpStart, stockBoardJumpEnd), /板块行情中未找到/);
  assert.doesNotMatch(html.slice(stockBoardJumpStart, stockBoardJumpEnd), /selectBoard\(matched\.code\)/);
  assert.match(html, /id="stock-board-context"/);
  assert.match(html, /function loadStockBoards\(sym\)/);
  assert.match(html, /id="modal-watchlist-btn"[^>]*onclick="openWatchlistAddDialog\(modalSym\)"/);
  assert.match(html, /id="watchlist-add-mask"/);
  assert.match(html, /id="watchlist-add-groups"/);
  assert.match(html, /function openWatchlistAddDialog\(sym\)/);
  assert.match(html, /function confirmWatchlistAdd\(\)/);
  assert.match(serverSource, /const BOARD_TYPES = \{/);
  assert.match(serverSource, /pathname === '\/api\/boards'/);
  assert.match(serverSource, /pathname === '\/api\/board'/);
  assert.match(serverSource, /pathname === '\/api\/stock-boards'/);
  assert.match(serverSource, /CompanySurveyAjax\?code=/);

  const start = html.indexOf('function boardNumber');
  const end = html.indexOf('function filteredBoardRows', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    sign:value => Number(value) > 0 ? '+' : '',
    cls:value => Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat',
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.boardPctForTest = boardPct; this.boardMoneyForTest = boardMoney;`, context);
  assert.equal(context.boardPctForTest(3.2), '+3.20%');
  assert.equal(context.boardPctForTest(-1.25), '-1.25%');
  assert.equal(context.boardMoneyForTest(123000000), '+1.23亿');
});

test('fund center exposes rankings, search, curves, holdings and public information drill-down', () => {
  assert.match(html, /data-page="funds"[^>]*onclick="switchAppPage\('funds'\)"/);
  assert.match(html, /id="page-funds"/);
  assert.match(html, /id="fund-search-input"[^>]*placeholder="搜索基金名称、代码或拼音"/);
  assert.match(html, /data-fund-type="stock"/);
  assert.match(html, /data-fund-type="mixed"/);
  assert.match(html, /data-fund-type="bond"/);
  assert.match(html, /data-fund-type="index"/);
  assert.doesNotMatch(html, /data-fund-type="watchlist"/);
  assert.doesNotMatch(html, /id="fund-watchlist-btn"/);
  assert.match(html, /id="fund-market-watchlist-btn"[^>]*onclick="openFundMarketWatchlist\(\)"/);
  assert.match(html, /function openEtfFundMarket\(\)/);
  assert.match(html, /id="modal-fund-link"[^>]*onclick="openEtfFundMarket\(\)"/);
  assert.match(html, /function openFundExchangeQuote\(\)/);
  assert.match(html, /查看交易所行情/);
  assert.doesNotMatch(html, /function toggleFundWatchlist\(\)/);
  assert.match(html, /function fundQuoteFromDetail\(detail, symbol = fundMarketSymbol\(detail\)\)/);
  assert.match(html, /openWatchlistAddDialog\(symbol\)/);
  assert.match(html, /function prepareFundChart\(\)/);
  assert.match(html, /前十大重仓个股/);
  assert.match(html, /现任基金经理/);
  assert.match(html, /基金资讯与公告/);
  assert.match(html, /function safeFundInfoUrl\(value\)/);
  assert.match(html, /lastFundQuoteData\[symbol\] = lastQuoteData\[symbol\]/);
  assert.match(serverSource, /pathname === '\/api\/funds'/);
  assert.match(serverSource, /pathname === '\/api\/fund-search'/);
  assert.match(serverSource, /pathname === '\/api\/fund-detail'/);
  assert.match(serverSource, /pathname === '\/api\/fund-quotes'/);
  assert.match(serverSource, /FUND_RATE_LIMIT_MAX = 90/);
});

test('listed ETFs from the fund center map into realtime watchlist symbols', () => {
  const start = html.indexOf('function listedEtfSymbol');
  const end = html.indexOf('function fundMarketSymbol', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.listedEtfSymbolForTest = listedEtfSymbol;`, context);
  assert.equal(context.listedEtfSymbolForTest('513300', '纳斯达克ETF华夏'), 'sh513300');
  assert.equal(context.listedEtfSymbolForTest('159941', '纳指ETF广发'), 'sz159941');
  assert.equal(context.listedEtfSymbolForTest('501018', '南方原油LOF'), '');
  assert.equal(context.listedEtfSymbolForTest('000001', 'ETF联接基金'), '');
  assert.equal(context.listedEtfSymbolForTest('513300', '普通指数基金'), '');
});

test('legacy fund watchlist entries migrate into unified market symbols', () => {
  const start = html.indexOf('function legacyFundMarketSymbols');
  const end = html.indexOf('let _stored = null', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.legacyFundMarketSymbolsForTest = legacyFundMarketSymbols;`, context);
  const symbols = context.legacyFundMarketSymbolsForTest([
    { code:'513300', name:'纳斯达克ETF华夏' },
    { code:'513300', name:'纳斯达克ETF华夏' },
    { code:'159941', name:'纳指ETF广发' },
    { code:'not-a-fund', name:'无效项' },
    '000001',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(symbols)), ['sh513300', 'sz159941', 'fund000001']);
});

test('ordinary funds use unified fund symbols and disclosure-based quotes', () => {
  assert.match(html, /return listedEtfSymbol\(detail\?\.code, description\) \|\| \(\/\^\\d\{6\}\$\//);
  assert.match(html, /function isFundWatchSymbol\(sym\)/);
  assert.match(html, /fetchFundWatchlistQuotes\(watchlist, forceFunds\)/);
  assert.match(html, /普通基金不适用盘中个股指标/);
});

test('add to watchlist dialog adds a stock to the chosen group and dedupes', () => {
  const start = html.indexOf('function addSymbolToGroup');
  const end = html.indexOf('function updateModalWatchlistButton', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.addSymbolToGroupForTest = addSymbolToGroup;`, context);
  const groups = [
    { id:'a', name:'默认分组', stocks:['sh600519'] },
    { id:'b', name:'长期持有', stocks:[] },
  ];
  assert.equal(context.addSymbolToGroupForTest(groups, 'b', 'sz000001'), true);
  assert.deepEqual(groups[1].stocks, ['sz000001']);
  assert.equal(context.addSymbolToGroupForTest(groups, 'a', 'sh600519'), false);
  assert.equal(context.addSymbolToGroupForTest(groups, 'missing', 'sh600519'), false);
  assert.equal(context.addSymbolToGroupForTest(groups, 'a', ''), false);
});

test('watchlist dialog syncs multi-select group membership and can remove from all groups', () => {
  assert.match(html, /type="checkbox" name="watchlist-add-group"/);
  assert.match(html, /id="watchlist-remove-all-btn"/);
  assert.match(html, /function confirmRemoveFromAllWatchlist\(\)/);
  assert.match(html, /function syncSymbolGroups\(groups, activeGroupId, sym, checkedGroupIds\)/);

  const start = html.indexOf('function addSymbolToGroup');
  const end = html.indexOf('function openWatchlistAddDialog', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.addSymbolToGroupForTest = addSymbolToGroup; this.syncSymbolGroupsForTest = syncSymbolGroups;`, context);
  const groups = [
    { id:'a', name:'默认分组', stocks:['sh600519', 'sz000001'] },
    { id:'b', name:'长期持有', stocks:['sz000001', 'hk00700'] },
  ];
  const activeStocks = groups[0].stocks;
  assert.equal(context.syncSymbolGroupsForTest(groups, 'a', 'sz000001', ['b']), true);
  assert.deepEqual(groups[0].stocks, ['sh600519']);
  assert.deepEqual(groups[1].stocks, ['sz000001', 'hk00700']);
  assert.equal(groups[0].stocks, activeStocks);
  assert.equal(context.syncSymbolGroupsForTest(groups, 'a', 'sz000001', ['a', 'b']), true);
  assert.deepEqual(groups[0].stocks, ['sh600519', 'sz000001']);
  assert.equal(context.syncSymbolGroupsForTest(groups, 'a', 'sh600519', ['a']), false);
  assert.equal(context.syncSymbolGroupsForTest(groups, 'a', 'hk00700', ['a']), true);
  assert.deepEqual(groups[1].stocks, ['sz000001']);
});

test('transfer dialog can remove a stock from all groups', () => {
  assert.match(html, /<option value="remove">从所有分组移除<\/option>/);
  assert.match(html, /function updateTransferMode\(\)/);
  assert.match(html, /function removeSymbolFromAllGroups\(groups, symbols\)/);
  assert.match(html, /onclick="openBatchTransfer\('remove'\)"/);

  const start = html.indexOf('function removeSymbolFromAllGroups');
  const end = html.indexOf('function openTransferDialog', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.removeSymbolFromAllGroupsForTest = removeSymbolFromAllGroups;`, context);
  const groups = [
    { id:'a', name:'默认分组', stocks:['sh600519', 'sz000001'] },
    { id:'b', name:'长期持有', stocks:['sz000001', 'hk00700'] },
  ];
  context.removeSymbolFromAllGroupsForTest(groups, ['sz000001']);
  assert.deepEqual(groups[0].stocks, ['sh600519']);
  assert.deepEqual(groups[1].stocks, ['hk00700']);
});

test('watchlist tool requests picture-in-picture directly from the click gesture and reports failures', () => {
  assert.match(html, /market-tool-label">画中画盯盘/);
  assert.match(html, /id="movable-float-btn"[^>]*onclick="openMovableFloatWindow\(\)"/);
  assert.match(html, /function pictureInPictureSupported\(\)/);
  assert.match(html, /function pictureInPictureApi\(video = stockPictureInPictureMedia\?\.video\)/);
  assert.match(html, /HTMLVideoElement\.prototype\.requestPictureInPicture/);
  assert.match(html, /HTMLVideoElement\.prototype\.webkitSetPresentationMode/);
  assert.match(html, /webkitSupportsPresentationMode\('picture-in-picture'\)/);
  assert.match(html, /function pictureInPictureApi[\s\S]*webkitSetPresentationMode[\s\S]*document\.pictureInPictureEnabled/);
  assert.match(html, /canvas\.captureStream\(5\)/);
  assert.match(html, /media\.video\.controls = true;/);
  assert.match(html, /media\.video\.srcObject = media\.stream;/);
  assert.match(html, /media\.video\.controls = false;/);
  assert.match(html, /const STOCK_PIP_CANVAS_WIDTH = 800/);
  assert.match(html, /const STOCK_PIP_CANVAS_HEIGHT = 500/);
  assert.match(html, /const STOCK_PIP_MAX_ROWS = 7/);
  assert.match(html, /700 15px ui-monospace/);
  assert.match(html, /requestPictureInPicture\(\)/);
  assert.match(html, /leavepictureinpicture/);
  assert.match(html, /function closeStockPictureInPicture\(/);
  assert.match(html, /function prepareStockPictureInPictureMedia\(\)/);
  assert.match(html, /function retryStockPictureInPictureMedia\(\)/);
  assert.match(html, /Safari 画中画正在重新准备，请稍候后再点一次/);
  assert.match(html, /prepareStockPictureInPictureMedia\(\)\.catch/);
  assert.match(html, /left:0;top:0;width:2px;height:2px;opacity:0\.01/);
  assert.match(html, /function openStandardFloatWindow\(\)/);
  assert.match(html, /function pictureInPictureStartMessage\(error\)/);
  assert.match(html, /画中画被浏览器拒绝；请关闭其他画中画窗口后重试/);
  assert.match(html, /自选盯盘 ·/);
  const pipStart = html.indexOf('async function openFloatWindow');
  const pipEnd = html.indexOf('// ============================================================\n// Notes Module', pipStart);
  assert.ok(pipStart >= 0 && pipEnd > pipStart);
  const pipStartSource = html.slice(pipStart, pipEnd);
  assert.match(pipStartSource, /state\.pipWindow = await state\.video\.requestPictureInPicture\(\)/);
  assert.match(pipStartSource, /state\.video\.webkitSetPresentationMode\('picture-in-picture'\)/);
  assert.match(pipStartSource, /STOCK_PIP_WEBKIT_NO_WINDOW/);
  assert.match(pipStartSource, /Safari 画中画未能启动，已重新准备；请稍候再点一次/);
  assert.match(pipStartSource, /retryStockPictureInPictureMedia\(\)\.catch/);
  assert.doesNotMatch(pipStartSource, /await state\.video\.play\(\)/);
  assert.doesNotMatch(pipStartSource, /openStandardFloatWindow\(\)/);
  assert.match(html, /popup=yes,width=620,height=560/);
  assert.match(html, /event\.data\?\.type === 'stock-float-open'/);
  assert.match(html, /\^\(\?:sh\|sz\|hk\|us\)\[a-zA-Z0-9\._-\]\+\$/);
  assert.match(floatHtml, /自选盯盘/);
  assert.match(floatHtml, /id="summary-up"/);
  assert.match(floatHtml, /id="summary-leader"/);
  assert.match(floatHtml, /data-sort="order"/);
  assert.match(floatHtml, /data-sort="pct"/);
  assert.match(floatHtml, /id="refresh-interval"/);
  assert.match(floatHtml, /function openStock\(symbol\)/);
  assert.match(floatHtml, /function returnToMainWindow\(\)/);
  assert.match(floatHtml, /window\.close\(\)/);
  assert.match(floatHtml, /stock-float-open/);
  assert.match(floatHtml, /quoteRefreshQueued/);
  assert.match(floatHtml, /document\.addEventListener\('visibilitychange'/);

  const start = floatHtml.indexOf('function sortFloatRows');
  const end = floatHtml.indexOf('function renderSummary', start);
  assert.ok(start >= 0 && end > start);
  const context = { sortMode:'pct' };
  vm.createContext(context);
  vm.runInContext(`${floatHtml.slice(start, end)}\nthis.sortFloatRowsForTest = sortFloatRows;`, context);
  const sorted = JSON.parse(JSON.stringify(context.sortFloatRowsForTest([
    { symbol:'sh600519', quote:{ pct:-1.2 } },
    { symbol:'usAAPL', quote:{ pct:1.8 } },
    { symbol:'sz000001', quote:null },
  ])));
  assert.deepEqual(sorted.map(item => item.symbol), ['usAAPL', 'sh600519', 'sz000001']);
});

test('web page opens the desktop client only on user action and exposes a safe download guide', () => {
  assert.match(html, /id="desktop-open-btn"[^>]*onclick="openDesktopClient\(\)"/);
  assert.match(html, /id="desktop-download-btn"[^>]*href="https:\/\/github\.com\/Sherlock-4869\/stock-desktop\/releases\/latest"/);
  assert.match(html, /id="desktop-launch-guide"/);
  assert.match(html, /https:\/\/github\.com\/Sherlock-4869\/stock-desktop\/releases\/latest/);
  const start = html.indexOf('function openDesktopClient');
  const end = html.indexOf('function applyListColorPreference', start);
  assert.ok(start >= 0 && end > start);
  const guide = { classList:{ add() {} }, querySelector:() => ({ href:'' }) };
  const context = {
    activeGroupId:'g_default',
    DESKTOP_DOWNLOAD_URL:'https://github.com/Sherlock-4869/stock-desktop/releases/latest',
    document:{ getElementById:id => id === 'desktop-launch-guide' ? guide : null },
    window:{ location:{ href:'' } },
    showToast() {},
    encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.openDesktopClient();
  assert.equal(context.window.location.href, 'stockwatch://watch?group=g_default');
  context.openDesktopClient('sh600519');
  assert.equal(context.window.location.href, 'stockwatch://stock?symbol=sh600519');
});

test('IPO calendar labels each stock board', () => {
  assert.match(html, /class="ipo-board">\$\{escapeHtml\(ipoBoard\(item\)\)\}/);
  const start = html.indexOf('function ipoBoard');
  const end = html.indexOf('async function fetchIpos', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.ipoBoardForTest = ipoBoard;`, context);
  assert.equal(context.ipoBoardForTest({ code:'301001' }), '创业板');
  assert.equal(context.ipoBoardForTest({ code:'301001', board:'非科创板' }), '创业板');
  assert.equal(context.ipoBoardForTest({ code:'001001', board:'非科创板' }), '深市主板');
  assert.equal(context.ipoBoardForTest({ code:'688001' }), '科创板');
  assert.equal(context.ipoBoardForTest({ code:'603001' }), '沪市主板');
  assert.equal(context.ipoBoardForTest({ code:'001001' }), '深市主板');
  assert.equal(context.ipoBoardForTest({ board:'上海证券交易所主板' }), '沪市主板');
});

test('IPO calendar expands a sanitized offering detail card using public fields', () => {
  assert.match(html, /class="ipo-row-summary" type="button" onclick="toggleIpoDetails/);
  assert.match(html, /function toggleIpoDetails\(detailId, control\)/);
  assert.match(html, /class="ipo-details" id="\$\{detailId\}" hidden/);
  assert.match(html, /\.ipo-details\[hidden\]\{display:none!important\}/);
  assert.match(html, /body\.sidebar-collapsed \.sidebar-group-toggle\{[^}]*border:1px solid #30363d/);
  assert.match(serverSource, /const columns = 'ALL';/);
  assert.match(serverSource, /recommendOrg:row\.RECOMMEND_ORG/);
  assert.match(serverSource, /mainBusiness:row\.MAIN_BUSINESS/);

  const start = html.indexOf('function ipoPresent');
  const end = html.indexOf('async function fetchIpos', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    },
    dateKey(value) { return String(value).slice(0, 10); },
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.ipoDetailsMarkupForTest = ipoDetailsMarkup;`, context);
  const detail = context.ipoDetailsMarkupForTest({
    price: 12.34, issuePe: 20, industryPe: 25, issueShares: 3000,
    onlineIssueShares: 1000000, upperLimit: 20000, requiredMarketCap: 15,
    recommendOrg: '测试保荐机构', mainBusiness: '<img src=x onerror=alert(1)>',
  });
  assert.match(detail, /发行与申购/);
  assert.match(detail, /测试保荐机构/);
  assert.match(detail, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(detail, /<img/);
});

test('administrator UI keeps system tools in the sidebar and provides role plus AI access management', () => {
  assert.match(html, /id="page-admin-sites"/);
  assert.match(html, /id="page-admin-users"/);
  assert.match(html, /id="admin-users-list"/);
  assert.match(html, /data-page="admin-users" onclick="switchAppPage\('admin-users'\)"/);
  assert.match(html, /\/api\/admin\/ai\/users/);
  assert.match(html, /function setAdminAiUserPermission\(user, canUse, button\)/);
  assert.match(html, /\/api\/admin\/users\/\$\{encodeURIComponent\(user\.id\)\}\/admin/);
  assert.match(html, /function setAdminUserRole\(user, isAdmin, button\)/);
  assert.match(html, /roleToggle\.textContent = isCurrentUser \? '当前账号' : \(user\.isAdmin \? '撤销管理员' : '授予管理员'\)/);
  assert.match(html, /id="admin-navigation" hidden/);
  assert.match(html, /data-page="admin-sites" onclick="switchAppPage\('admin-sites'\)"/);
  assert.match(html, /apiRequest\('\/api\/admin\/sites'/);
  assert.match(html, /async function saveAdminSite\(event\)/);
  assert.match(html, /async function deleteAdminSite\(siteId\)/);
  assert.match(html, /id="admin-site-admin-only"[^>]*type="checkbox"/);
  assert.match(html, /isAdminOnly:document\.getElementById\('admin-site-admin-only'\)\.checked/);
  assert.match(html, /site\.isAdminOnly === true/);
  assert.match(html, /visibility\.textContent = '仅管理员可见'/);
  assert.match(html, /page === 'admin-users' \|\| page === 'admin-sites' \|\| page === 'admin-ai'/);
  assert.match(html, /if \(user\.isAdmin\).*管理员默认可用/s);
  const accountRenderStart = html.indexOf('function renderAccountArea');
  const accountRenderEnd = html.indexOf('function positionAccountMenu', accountRenderStart);
  assert.ok(accountRenderStart >= 0 && accountRenderEnd > accountRenderStart);
  const accountRender = html.slice(accountRenderStart, accountRenderEnd);
  assert.doesNotMatch(accountRender, /openAdmin(UserManagement|AiManagement|SiteManagement)|openUserAiModels/);
  assert.doesNotMatch(html, /name="isAdmin"|grantAdmin\(/);
});

test('AI stock research UI keeps entry permission-gated and renders chat content as text', () => {
  assert.match(html, /id="ai-entry-btn"[^>]*data-page="ai"[^>]*hidden/);
  assert.match(html, /id="user-ai-models-entry"[^>]*data-page="user-ai-models"/);
  assert.match(html, /id="user-ai-models-entry"[^>]*title="AI模型"/);
  assert.match(html, /id="page-ai"/);
  assert.match(html, /id="page-admin-ai"/);
  assert.match(html, /id="page-user-ai-models"/);
  assert.match(html, /id="ai-model-picker"[^>]*aria-label="本次问股模型"/);
  assert.match(html, /id="ai-model-select"[^>]*onchange="setAiModelSelection\(this\.value\)"/);
  assert.match(html, /id="ai-model-empty"[^>]*>当前没有配置可用模型/);
  assert.doesNotMatch(html, /id="ai-model-catalog-load"|id="ai-provider-model-select"/);
  assert.match(html, /select\.disabled = models\.length < 2 \|\| aiRequestInFlight/);
  assert.match(html, /\.ai-chat-pane\{overflow:hidden\}/);
  assert.match(html, /\.ai-messages\{overflow-y:scroll/);
  assert.match(html, /\.ai-workspace\{height:min\(780px,calc\(100vh - 130px\)\);max-height:none/);
  assert.match(html, /\/api\/ai\/access/);
  assert.match(html, /\/api\/ai\/user-models/);
  assert.match(html, /\/api\/ai\/model-catalog/);
  assert.match(html, /\/api\/ai\/conversations/);
  assert.match(html, /\/api\/admin\/ai\/models/);
  assert.match(html, /\/api\/admin\/ai\/usage/);
  assert.match(html, /\/api\/admin\/ai\/users/);
  assert.match(html, /modelId:selectedAiModelId \|\| undefined, stockContext:stockContextForAi\(\)/);
  assert.match(html, /function createAiMessageElement\(message\)[\s\S]*?content\.textContent = message\.content/);
  assert.match(html, /if \(page === 'ai' && !hasAiMenuAccess\(\)\)/);
  assert.match(html, /if \(page === 'user-ai-models' && !hasAiMenuAccess\(\)\)/);
  assert.doesNotMatch(html, /id="admin-ai-public"|<h3>页面权限<\/h3>/);
  assert.match(html, /function hasAiMenuAccess\(\)/);
  assert.match(html, /function syncRestrictedNavigation\(\)/);
  assert.match(html, /sidebar-group-ai'\)\?\.toggleAttribute\('hidden', !aiVisible\)/);
  assert.match(html, /admin-navigation'\)\?\.toggleAttribute\('hidden', !adminVisible\)/);
  assert.match(html, /\.sidebar-group\[hidden\]\{display:none!important\}/);
  assert.match(html, /if \(page === 'admin-users'\) loadAdminAiUsers\(true\)/);
  assert.match(html, /function testAiModelConnection\(scope\)/);
  assert.match(html, /if \(!aiAccess\.canUse\) \{[\s\S]*?配置模型后即可创建问股会话/);
  assert.match(html, /ai-entry-btn'\)\?\.toggleAttribute\('hidden', !aiVisible\)/);
  assert.match(html, /function setAdminAiModelActive\(id, isActive, button\)/);
  assert.match(html, /function setUserAiModelActive\(id, isActive, button\)/);
  assert.match(html, /toggle\.textContent = model\.isActive \? '停用' : '启用'/);
  assert.match(html, /id="user-ai-model-test"[^>]*onclick="testAiModelConnection\('user'\)"/);
  assert.match(html, /id="admin-ai-model-test"[^>]*onclick="testAiModelConnection\('admin'\)"/);
});

test('fund flow chart uses only an explicitly marked same-source cache fallback', () => {
  assert.match(html, /主力资金数据暂时拿不到，请稍后重试/);
  assert.match(html, /d\.meta\?\.stale/);
  assert.match(html, /d\.meta\?\.realtime/);
  assert.match(html, /当前仅显示/);
  assert.match(html, /今日实时资金/);
  assert.match(html, /历史曲线暂时获取不到，当前仅显示今日实时资金/);
  assert.match(html, /retry\.textContent = '重新获取历史'/);
  assert.match(html, /retry\.textContent = '刷新历史'/);
  assert.match(html, /loadChart\('fundFlow', \{ forceFundFlowRefresh:true \}\)/);
  assert.match(html, /&refresh=1/);
  assert.doesNotMatch(html, /新浪财经备用历史数据/);
});

test('ETF search and charts are supported without exposing stock-only metrics or money flow', () => {
  assert.match(html, /搜索 A 股、ETF、港股、美股名称或代码/);
  assert.match(html, /function isEtfSymbol\(sym, quote = null\)/);
  assert.match(html, /securityType:fields\.includes\('ETF'\) \? 'ETF' : 'STOCK'/);
  assert.match(html, /tag-etf/);
  assert.match(html, /ETF 不适用该公司指标/);
  assert.match(html, /t\.hidden = isEtf && t\.dataset\.tab === 'fundFlow'/);
  assert.match(html, /ETF 支持实时行情、分时和 K 线；不提供个股板块和主力资金/);
  assert.match(serverSource, /parseTencentSecuritySearch\(text\)/);
  assert.match(serverSource, /sh5\\d\{5\}\|sz15\\d\{4\}/);
  assert.match(serverSource, /function isAStockSymbol\(symbol\)/);
  assert.match(serverSource, /主力资金目前仅支持普通 A 股/);
});

test('Shanghai and Shenzhen ETF symbols are excluded from stock-only behavior', () => {
  const start = html.indexOf('function isEtfSymbol');
  const end = html.indexOf('function isAStockSymbol', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.isEtfSymbolForTest = isEtfSymbol;`, context);
  assert.equal(context.isEtfSymbolForTest('sh513300'), true);
  assert.equal(context.isEtfSymbolForTest('sz159941'), true);
  assert.equal(context.isEtfSymbolForTest('sh600519'), false);
});

test('five-day main flow is shown only in the fund flow panel, not list metrics', () => {
  assert.match(html, /\['近五日累计', fmtMetricMoney\(latest\.mainFiveDay\)/);
  assert.doesNotMatch(html, /main_five_day|metric-main-five-day|value="main_five_day"/);
  assert.doesNotMatch(serverSource, /includeFiveDay|fiveDay/);
});

test('chat UI loads persisted history upward while bounding rendered content', () => {
  assert.match(html, /const CHAT_MAX_RENDERED_MESSAGES = 500;/);
  assert.match(html, /const CHAT_MAX_RENDERED_IMAGES = 50;/);
  assert.match(html, /const CHAT_INITIAL_HISTORY_PAGE_SIZE = 20;/);
  assert.match(html, /const CHAT_HISTORY_PAGE_SIZE = 50;/);
  assert.match(html, /id="chat-history-loader"[^>]*onclick="loadMoreChatHistory\(\)"/);
  assert.match(html, /getElementById\('chat-messages'\)\.addEventListener\('scroll'/);
  assert.match(html, /scrollTop <= 72\) loadMoreChatHistory\(\)/);
  assert.match(html, /function clearChatSessionView\(\)[\s\S]*?messages\.replaceChildren\(\)/);
  assert.match(html, /while \(container\.childElementCount > CHAT_MAX_RENDERED_MESSAGES\)/);
  assert.match(html, /while \(container\.querySelectorAll\('\.chat-msg-image'\)\.length > CHAT_MAX_RENDERED_IMAGES\)/);
  assert.match(html, /oldestImage\.replaceWith\(placeholder\)/);

  const sessionStart = html.indexOf('async function loadChatSession');
  const sessionEnd = html.indexOf('function updateChatOnline', sessionStart);
  assert.ok(sessionStart >= 0 && sessionEnd > sessionStart);
  const historyFunctions = html.slice(sessionStart, sessionEnd);
  assert.match(historyFunctions, /\/api\/chat\/history\?limit=\$\{CHAT_INITIAL_HISTORY_PAGE_SIZE\}/);
  assert.match(historyFunctions, /chatState\.historySince = data\.historySince \|\| null/);
  assert.match(html, /展开更早聊天记录/);
  assert.match(historyFunctions, /appendChatMessage\(message, false\)/);
  assert.match(historyFunctions, /async function loadMoreChatHistory\(\)/);
  assert.match(historyFunctions, /before:chatState\.historyCursor/);
  assert.match(historyFunctions, /appendChatMessage\(message, false, true\)/);
  assert.match(historyFunctions, /container\.scrollTop = previousTop \+ Math\.max/);
});

test('theme picker supports bright and dark skins while retaining system preference', () => {
  assert.match(html, /const THEME_PREFERENCES = \['light','paper','dark','ocean','forest','violet','system'\]/);
  assert.match(html, /data-theme-skin/);
  assert.match(html, /<option value="paper">暖纸<\/option>/);
  assert.match(html, /<option value="ocean">深海<\/option>/);
  assert.match(html, /<option value="forest">松林<\/option>/);
  assert.match(html, /<option value="violet">暮紫<\/option>/);
  assert.match(html, /Complete the bright surface treatment for chat, account, AI, and administration pages/);
});

test('minimized chat icon supports bounded pointer dragging without accidental restore', () => {
  assert.match(html, /<button class="chat-minimized" id="chat-minimized"[^>]*aria-label="打开聊天室，可拖动位置"/);
  assert.match(html, /\.chat-minimized\{[^}]*touch-action:none/);
  assert.match(html, /initChatMinimizedDrag\(\);/);
  assert.match(html, /addEventListener\('pointerdown'/);
  assert.match(html, /addEventListener\('pointermove'/);
  assert.match(html, /Math\.hypot\(dx, dy\) < 4/);
  assert.match(html, /if \(ignoreNextClick\)[\s\S]*?event\.preventDefault\(\)/);

  const start = html.indexOf('function clampChatMinimizedPosition');
  const end = html.indexOf('function keepChatMinimizedInViewport', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(-10, -20, 52, 52, 320, 480))), { left:0, top:0 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(400, 500, 52, 52, 320, 480))), { left:268, top:428 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(10, 10, 52, 52, 20, 20))), { left:0, top:0 });
});

test('restored chat window opens beside the dragged minimized icon', () => {
  assert.match(html, /function restoreChatRoom\(\)[\s\S]*?float\.classList\.add\('open'\);\s*positionChatFloatNearMinimizedIcon\(\);\s*icon\.classList\.remove\('visible'\)/);
  const start = html.indexOf('function calculateChatFloatPosition');
  const end = html.indexOf('function positionChatFloatNearMinimizedIcon', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  const rightIcon = { left:740, right:792, top:700, height:52 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateChatFloatPosition(rightIcon, 380, 520, 800, 800))), {
    left:350, top:232, side:'left',
  });
  const leftIcon = { left:8, right:60, top:200, height:52 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateChatFloatPosition(leftIcon, 380, 520, 800, 800))), {
    left:70, top:8, side:'right',
  });
});

test('minimizing a dragged chat places its icon beside the expanded window', () => {
  assert.match(html, /if \(chatState\.floatMoved\) positionChatMinimizedNearFloat\(\)/);
  assert.match(html, /Math\.hypot\(dx, dy\) >= 4\) chatState\.floatMoved = true/);
  const start = html.indexOf('function clampChatMinimizedPosition');
  const end = html.indexOf('function keepChatMinimizedInViewport', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  const expanded = { left:200, right:580, top:180, bottom:700 };
  const iconPosition = JSON.parse(JSON.stringify(context.calculateChatMinimizedPositionFromFloat(expanded, 52, 52, 800, 800)));
  assert.deepEqual(iconPosition, { left:590, top:648, side:'right' });
  const restored = JSON.parse(JSON.stringify(context.calculateChatFloatPosition(
    { left:iconPosition.left, right:iconPosition.left + 52, top:iconPosition.top, height:52 },
    380, 520, 800, 800
  )));
  assert.deepEqual(restored, { left:200, top:180, side:'left' });
});

test('chat UI exposes emoji and validated image controls', () => {
  assert.match(html, /id="chat-emoji-btn"/);
  assert.match(html, /id="chat-emoji-panel"/);
  const emojiSource = html.match(/const CHAT_EMOJIS = \[([\s\S]*?)\];/);
  assert.ok(emojiSource, 'chat emoji list should be present');
  const emojiValues = (emojiSource[1].match(/'[^']+'/g) || []).map(value => value.slice(1, -1));
  assert.ok(emojiValues.length >= 190, 'chat should retain common emoji and a broad face selection');
  assert.equal(new Set(emojiValues).size, emojiValues.length, 'chat emoji should not include duplicate variants');
  assert.ok(emojiValues.includes('🫠') && emojiValues.includes('😶‍🌫️') && emojiValues.includes('🫨'));
  assert.equal(emojiValues.some(emoji => Array.from(emoji).some(char => {
    const codePoint = char.codePointAt(0);
    return codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF;
  })), false, 'chat emoji should exclude flags');
  assert.match(html, /chat-emoji-panel\{[^}]*grid-template-columns:repeat\(8,30px\)[^}]*column-gap:3px[^}]*row-gap:2px[^}]*width:298px[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(html, /id="chat-image-btn"[\s\S]*?<svg class="chat-tool-icon"/);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/gif,image\/webp"/);
  assert.match(html, /async function prepareChatImage\(file\)/);
  assert.match(html, /async function sendChatImage\(file\)/);
  assert.match(html, /addEventListener\('paste', handleChatPaste\)/);
  assert.match(html, /function handleChatPaste\(event\)/);
  assert.match(html, /clipboardData\?\.items/);

  const start = html.indexOf('function safeChatImageUrl');
  const end = html.indexOf('function toggleChatEmoji', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`const CHAT_MAX_IMAGE_BYTES = 768 * 1024;\n${html.slice(start, end)}`, context);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(context.safeChatImageUrl(png), png);
  assert.equal(context.safeChatImageUrl('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(context.safeChatImageUrl('javascript:alert(1)'), '');
});

test('account settings provide a validated custom-avatar control', () => {
  assert.match(html, /id="profile-display-name" name="displayName"/);
  assert.match(html, /async function submitProfileChange\(event\)/);
  assert.match(html, /apiRequest\('\/api\/auth\/profile'/);
  assert.match(html, /id="account-avatar-input" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /async function prepareAccountAvatar\(file\)/);
  assert.match(html, /apiRequest\('\/api\/auth\/avatar'/);
  assert.match(html, /removeAccountAvatar\(\)/);
});

test('administrator chat UI can request the server-authorized online user list', () => {
  assert.match(html, /id="chat-online-users"/);
  assert.match(html, /async function loadChatOnlineUsers\(\)/);
  assert.match(html, /apiRequest\('\/api\/chat\/online-users'/);
  assert.match(html, /if \(!currentUser\?\.isAdmin\) return/);
});

test('fund flow failures expose an in-place retry action', () => {
  assert.match(html, /className = 'chart-retry-btn'/);
  assert.match(html, /retry\.addEventListener\('click', \(\) => loadChart\('fundFlow', \{ forceFundFlowRefresh:true \}\)\)/);
  assert.match(html, /主力资金数据暂时拿不到，请稍后重试/);
});
