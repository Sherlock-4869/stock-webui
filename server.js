const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createWechatService } = require('./wechat/service');
const { createAccountService } = require('./account/service');
const { createAiService } = require('./ai/service');
const { createChatService } = require('./chat/chat');
const {
  createAsyncTaskQueue,
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
} = require('./fund-flow-history');
const {
  parseFundHoldings,
  parseFundNews,
  parseFundRanking,
  parseFundScript,
  parseFundSearch,
} = require('./fund-data');
const {
  normalizeSecuritySearchQuery,
  parseTencentSecuritySearch,
} = require('./stock-search');
const {
  createQuoteSnapshotCache,
  normalizeQuoteSymbols,
} = require('./quote-feed');
const { fundQuoteFromProfile } = require('./fund-quote');
const {
  FLOW_PERIODS,
  consecutiveFlowDays,
  flowRankingFields,
  mergeFlowSeries,
  normalizeFlowRankingRow,
  parseIntradayFlowPayload,
} = require('./capital-flow');
const {
  CFFEX_PRODUCTS,
  normalizeCffexFuture,
  parseEastmoneyFastNews,
  parseFuturesFlashHtml,
  parseSinaGlobalFutures,
  parseSinaSpotIndexes,
} = require('./derivatives-market');
const {
  normalizeAnnouncementPayload,
  normalizeBusinessAnalysisPayload,
  normalizeCompanySurvey,
  normalizeEarningsForecastPayload,
  normalizeFinancialPayload,
  normalizeHolderNumberPayload,
  parseSinaStockNews,
} = require('./stock-information');
const { normalizeLimitPoolPayload } = require('./limit-pools');
const { parseTencentOrderBook } = require('./order-book');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFERENCE_DOC_PATH = path.join(__dirname, 'doc', '参考文档.md');
const gbkDecode = require('./iconv_gbk');
const REFERENCE_DOCUMENT_SEED = {
  title:'默认参考文档',
  description:'选股指标、行情基础和交易规则的站内阅读手册',
  content:fs.existsSync(REFERENCE_DOC_PATH) ? fs.readFileSync(REFERENCE_DOC_PATH, 'utf8') : '',
  sortOrder:0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

const UPSTREAM_HEADERS = {
  'Referer': 'https://finance.qq.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const GLOBAL_TENCENT_INDEXES = [
  ['sh000001', '000001'], ['sz399001', '399001'], ['sz399006', '399006'],
  ['sh000688', '000688'], ['bj899050', '899050'],
  ['r_hkHSI', 'HSI'], ['r_hkHSTECH', 'HSTECH'],
  ['usDJI', 'DJIA'], ['usIXIC', 'IXIC'], ['usINX', 'SPX'],
];
const GLOBAL_SINA_INDEXES = [
  ['b_KOSPI', 'KOSPI'], ['b_NKY', 'N225'],
  ['b_DAX', 'GDAXI'], ['b_UKX', 'FTSE'],
];
const GLOBAL_MARKET_CACHE_MS = 4500;
const globalMarketCache = new Map();
let globalMarketSnapshot = null;
let globalMarketRefreshPromise = null;
const quoteSnapshotCache = createQuoteSnapshotCache({ maxEntries:500, maxAgeMs:15 * 60 * 1000 });
const IPO_CACHE_MS = 15 * 60 * 1000;
let ipoCache = null;
let ipoRefreshPromise = null;
const FUNDAMENTAL_CACHE_MS = 6 * 60 * 60 * 1000;
const REALTIME_FUND_FLOW_CACHE_MS = 4500;
const REALTIME_VALUATION_CACHE_MS = 4500;
const BOARD_LIST_CACHE_MS = 12 * 1000;
const BOARD_DETAIL_CACHE_MS = 8 * 1000;
const STOCK_BOARD_CACHE_MS = 6 * 60 * 60 * 1000;
const BOARD_LIST_PAGE_SIZE = 1000;
const BOARD_COMPONENT_PAGE_SIZE = 1000;
const CAPITAL_FLOW_RANKING_CACHE_MS = 12 * 1000;
const CAPITAL_FLOW_INTRADAY_CACHE_MS = 4500;
const CAPITAL_FLOW_HISTORY_CACHE_MS = 15 * 60 * 1000;
const MARKET_OVERVIEW_CACHE_MS = 8 * 1000;
const LIMIT_POOL_CACHE_MS = 10 * 1000;
const DERIVATIVES_QUOTE_CACHE_MS = 5 * 1000;
const DERIVATIVES_NEWS_CACHE_MS = 2 * 60 * 1000;
const STOCK_ANNOUNCEMENT_CACHE_MS = 15 * 60 * 1000;
const STOCK_FINANCIAL_CACHE_MS = 6 * 60 * 60 * 1000;
const STOCK_EARNINGS_FORECAST_CACHE_MS = 6 * 60 * 60 * 1000;
const STOCK_NEWS_CACHE_MS = 5 * 60 * 1000;
const STOCK_PROFILE_CACHE_MS = 6 * 60 * 60 * 1000;
const STOCK_BUSINESS_ANALYSIS_CACHE_MS = 6 * 60 * 60 * 1000;
const STOCK_HOLDER_NUMBER_CACHE_MS = 6 * 60 * 60 * 1000;
const STOCK_INFORMATION_CACHE_MAX = 500;
const fundamentalCache = new Map();
const realtimeFundFlowCache = new Map();
const realtimeValuationCache = new Map();
const boardListCache = new Map();
const boardDetailCache = new Map();
const stockBoardCache = new Map();
const boardListRefreshes = new Map();
const boardDetailRefreshes = new Map();
const stockBoardRefreshes = new Map();
const fundRankingCache = new Map();
const fundDetailCache = new Map();
const fundSearchCache = new Map();
const fundQuoteCache = new Map();
const fundRateLimitBuckets = new Map();
const capitalFlowRateLimitBuckets = new Map();
const limitPoolRateLimitBuckets = new Map();
const capitalFlowRankingCache = new Map();
const capitalFlowIntradayCache = new Map();
const capitalFlowHistoryCache = new Map();
const marketOverviewCache = new Map();
const limitPoolCache = new Map();
const derivativesQuoteCache = new Map();
const derivativesNewsCache = new Map();
const derivativesRateLimitBuckets = new Map();
const stockAnnouncementCache = new Map();
const stockFinancialCache = new Map();
const stockEarningsForecastCache = new Map();
const stockNewsCache = new Map();
const stockProfileCache = new Map();
const stockBusinessAnalysisCache = new Map();
const stockHolderNumberCache = new Map();
const stockInformationRateLimitBuckets = new Map();
let derivativesQuoteRefreshPromise = null;
const boardRequestQueue = createAsyncTaskQueue({ concurrency:3, maxQueued:30 });
const fundQuoteRequestQueue = createAsyncTaskQueue({ concurrency:3, maxQueued:60 });
// Eastmoney's historical money-flow endpoint is much less tolerant of bursts
// than its realtime quote endpoint.  Serialize these refreshes; the loader
// below coalesces requests for the same symbol and serves a valid cache first.
const fundFlowHistoryRequestQueue = createAsyncTaskQueue({ concurrency:1, maxQueued:30 });

const BOARD_TYPES = {
  industry: { label:'行业板块', fs:'m:90+t:2+f:!50' },
  concept: { label:'概念板块', fs:'m:90+t:3+f:!50' },
  region: { label:'地域板块', fs:'m:90+t:1+f:!50' },
};
const FUND_TYPES = {
  all:{ upstream:'all', label:'全部基金' },
  stock:{ upstream:'gp', label:'股票型' },
  mixed:{ upstream:'hh', label:'混合型' },
  bond:{ upstream:'zq', label:'债券型' },
  index:{ upstream:'zs', label:'指数型' },
  qdii:{ upstream:'qdii', label:'QDII' },
  fof:{ upstream:'fof', label:'FOF' },
};
const FUND_RANK_PERIODS = {
  daily:{ label:'今日', upstream:'rzf' },
  week:{ label:'近一周', upstream:'zzf' },
  month:{ label:'近一月', upstream:'1yzf' },
  threeMonths:{ label:'近三月', upstream:'3yzf' },
  sixMonths:{ label:'近六月', upstream:'6yzf' },
  year:{ label:'近一年', upstream:'1nzf' },
  twoYears:{ label:'近两年', upstream:'2nzf' },
  threeYears:{ label:'近三年', upstream:'3nzf' },
  yearToDate:{ label:'今年以来', upstream:'jnzf' },
  sinceInception:{ label:'成立以来', upstream:'lnzf' },
};
const FUND_RANKING_CACHE_MS = 5 * 60 * 1000;
const FUND_DETAIL_CACHE_MS = 10 * 60 * 1000;
const FUND_SEARCH_CACHE_MS = 60 * 1000;
const FUND_QUOTE_CACHE_MS = 5 * 60 * 1000;
const FUND_QUOTE_CACHE_MAX = 1000;
const FUND_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FUND_RATE_LIMIT_MAX = 90;
const CAPITAL_FLOW_RATE_LIMIT_MAX = 120;
const LIMIT_POOL_RATE_LIMIT_MAX = 60;
const DERIVATIVES_RATE_LIMIT_MAX = 120;
const STOCK_INFORMATION_RATE_LIMIT_MAX = 60;
const ORDER_BOOK_CACHE_MS = 2500;
const orderBookCache = new Map();
const ORDER_BOOK_RATE_LIMIT_MAX = 180;
const orderBookRateLimitBuckets = new Map();

const CFFEX_NODES = { IF:'qz_qh', IH:'szgz_qh', IC:'zzgz_qh', IM:'im_qh' };
const US_NEWS_KEYWORDS = [
  '美股','美国股市','盘前','盘后','纳指','纳斯达克','标普','道指','华尔街','美联储',
  '英伟达','苹果','微软','特斯拉','亚马逊','谷歌','meta','美国科技股','美国银行',
];

const STOCK_FLOW_MARKETS = {
  all:'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  sh:'m:1+t:2,m:1+t:23',
  sz:'m:0+t:6,m:0+t:80',
  main:'m:0+t:6,m:1+t:2',
  cyb:'m:0+t:80',
  kcb:'m:1+t:23',
};
const MAINLAND_MARKET_INDEXES = {
  '000001':{ name:'上证指数', secid:'1.000001' },
  '399001':{ name:'深证成指', secid:'0.399001' },
  '399006':{ name:'创业板指', secid:'0.399006' },
  '000688':{ name:'科创50', secid:'1.000688' },
  '899050':{ name:'北证50', secid:'0.899050' },
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function staticReferenceDocument() {
  return {
    id:'static', title:REFERENCE_DOCUMENT_SEED.title, description:REFERENCE_DOCUMENT_SEED.description,
    sortOrder:REFERENCE_DOCUMENT_SEED.sortOrder, isActive:true, updatedAt:null,
    content:REFERENCE_DOCUMENT_SEED.content,
  };
}

function serveReferenceContent(res, document, download=false) {
  if (!document) { res.writeHead(404); res.end('Not Found'); return; }
  const headers = {
    'Content-Type':'text/markdown; charset=utf-8',
    'Cache-Control':'no-cache',
  };
  if (download) {
    const filename = `${String(document.title || '参考文档').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || '参考文档'}.md`;
    headers['Content-Disposition'] = `attachment; filename="reference-document.md"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  res.writeHead(200, headers);
  res.end(String(document.content || ''));
}

async function proxyQuote(symbols, res) {
  let liveLines = new Map();
  let upstreamFailed = false;
  try {
    const buffer = await requestBuffer(
      `https://qt.gtimg.cn/q=${symbols.join(',')}`,
      UPSTREAM_HEADERS,
      { timeoutMs:8000, maxBytes:2 * 1024 * 1024 }
    );
    liveLines = quoteSnapshotCache.store(gbkDecode(buffer));
    if (!liveLines.size) throw new Error('Upstream quote payload is empty');
  } catch (error) {
    upstreamFailed = true;
    console.error('Quote upstream error:', error.message);
  }

  const result = quoteSnapshotCache.compose(symbols, { liveLines });
  if (!result.text) {
    res.writeHead(502, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store' });
    res.end('Quote data is temporarily unavailable');
    return;
  }
  const status = upstreamFailed ? 'stale' : result.stale.length || result.missing.length ? 'partial' : 'live';
  res.writeHead(200, {
    'Content-Type':'text/plain; charset=utf-8',
    'Cache-Control':'no-cache',
    'X-Stock-Quote-Status':status,
    'X-Stock-Stale-Symbols':result.stale.join(','),
    'X-Stock-Missing-Symbols':result.missing.join(','),
    'X-Stock-Fetched-At':String(Date.now()),
  });
  res.end(result.text);
}

async function proxyOrderBook(urlObj, res) {
  const symbol = String(urlObj.searchParams.get('symbol') || urlObj.searchParams.get('sym') || '').trim().toLowerCase();
  if (!/^s[hz]\d{6}$/.test(symbol) || !isAStockSymbol(symbol)) {
    sendJson(res, 400, { error:'Invalid A-share symbol' });
    return;
  }
  const force = urlObj.searchParams.get('refresh') === '1';
  const now = Date.now();
  const cached = orderBookCache.get(symbol);
  if (!force && cached && now - cached.fetchedAt < ORDER_BOOK_CACHE_MS) {
    sendJson(res, 200, { ...cached.data, fetchedAt:cached.fetchedAt, stale:false });
    return;
  }
  try {
    const buffer = await requestBuffer(`https://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`, UPSTREAM_HEADERS, {
      timeoutMs:8000, maxBytes:256 * 1024,
    });
    const data = parseTencentOrderBook(symbol, gbkDecode(buffer));
    if (!data) throw new Error('Order book payload is empty');
    const fetchedAt = Date.now();
    if (orderBookCache.size >= 500 && !orderBookCache.has(symbol)) {
      orderBookCache.delete(orderBookCache.keys().next().value);
    }
    orderBookCache.set(symbol, { data, fetchedAt });
    sendJson(res, 200, { ...data, updatedAt:data.updated || null, fetchedAt, stale:false,
      source:'腾讯财经公开行情' });
  } catch (error) {
    console.error('Order book upstream error:', error.message);
    if (cached?.data) {
      sendJson(res, 200, { ...cached.data, updatedAt:cached.data.updated || null,
        fetchedAt:cached.fetchedAt, stale:true, source:'腾讯财经公开行情' });
      return;
    }
    // The regular watchlist quote endpoint uses the same Tencent source and
    // keeps a longer-lived per-symbol snapshot. Reuse it when the dedicated
    // request is briefly blocked by DNS, rate limiting, or an upstream timeout.
    const quoteFallback = quoteSnapshotCache.compose([symbol]).text;
    const fallbackData = parseTencentOrderBook(symbol, quoteFallback);
    if (fallbackData) {
      sendJson(res, 200, { ...fallbackData, updatedAt:fallbackData.updated || null,
        fetchedAt:Date.now(), stale:true, source:'腾讯财经公开行情（报价缓存回退）' });
      return;
    }
    sendJson(res, 502, { error:'盘口数据暂时不可用' });
  }
}

function proxyJson(url, res) {
  const req = https.get(url, { headers: UPSTREAM_HEADERS, timeout: 8000 }, (r) => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      let text = Buffer.concat(chunks).toString('utf-8');
      text = text.replace(/^[^=]+=/, ''); // strip JSONP wrapper
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(text);
    });
  });
  req.on('timeout', () => { req.destroy(); res.writeHead(504); res.end('{}'); });
  req.on('error', (e) => { res.writeHead(502); res.end('{}'); });
}

function requestBuffer(url, headers, { timeoutMs = 8000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout:timeoutMs }, (r) => {
      if (r.statusCode < 200 || r.statusCode >= 300) {
        r.resume();
        reject(new Error(`Upstream HTTP ${r.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      r.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          r.destroy(new Error('Upstream payload is too large'));
          return;
        }
        chunks.push(chunk);
      });
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isAShareSymbol(symbol) {
  return /^(?:sh|sz)\d{6}$/.test(symbol);
}

function isEtfSymbol(symbol) {
  // These ranges cover the exchange-traded funds supported by Tencent's quote
  // feed. Their company and money-flow fields are not A-share fields.
  return /^(?:sh5\d{5}|sz15\d{4})$/.test(symbol);
}

function isAStockSymbol(symbol) {
  return isAShareSymbol(symbol) && !isEtfSymbol(symbol);
}

function eastmoneySecuCode(symbol) {
  if (!isAStockSymbol(symbol)) return '';
  return `${symbol.slice(2)}.${symbol.startsWith('sh') ? 'SH' : 'SZ'}`;
}

function eastmoneySecId(symbol) {
  if (!isAStockSymbol(symbol)) return '';
  return `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`;
}

async function fetchEastmoneyFundFlowHistory(symbol) {
  const fields1 = 'f1,f2,f3,f7';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
  const query = `secid=${eastmoneySecId(symbol)}&lmt=120&klt=101&fields1=${fields1}&fields2=${fields2}`;
  return fundFlowHistoryRequestQueue.run(async () => {
    const raw = await requestBuffer(
      `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${query}`,
      { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/' },
      { timeoutMs:8000 }
    );
    return parseFundFlowHistoryPayload(JSON.parse(raw.toString('utf-8')));
  });
}

const fundFlowHistoryLoader = createFundFlowHistoryLoader({
  source:'eastmoney-daykline',
  fetchData:fetchEastmoneyFundFlowHistory,
  loadPersisted:symbol => accountService.loadFundFlowHistoryCache(symbol),
  savePersisted:(symbol, value) => accountService.saveFundFlowHistoryCache(symbol, value),
  freshMs:15 * 60 * 1000,
  fallbackMs:7 * 24 * 60 * 60 * 1000,
  refreshCooldownMs:60 * 1000,
  retryDelayMs:750,
  attempts:2,
  onPersistenceError:(error, symbol, operation) => {
    console.error(`Fund flow cache ${operation} error (${symbol}):`, error.message);
  },
});

const boardFundFlowHistoryLoader = createFundFlowHistoryLoader({
  source:'eastmoney-daykline',
  fetchData:key => fundFlowHistoryRequestQueue.run(async () => {
    const code = String(key).replace(/^board:/, '');
    const result = await fetchCapitalFlowHistory(`90.${code}`);
    return result.data;
  }),
  loadPersisted:key => accountService.loadFundFlowHistoryCache(key),
  savePersisted:(key, value) => accountService.saveFundFlowHistoryCache(key, value),
  freshMs:CAPITAL_FLOW_HISTORY_CACHE_MS,
  fallbackMs:7 * 24 * 60 * 60 * 1000,
  refreshCooldownMs:60 * 1000,
  retryDelayMs:750,
  attempts:2,
  onPersistenceError:(error, key, operation) => {
    console.error(`Board fund flow cache ${operation} error (${key}):`, error.message);
  },
});

async function loadFundFlowHistoryResult(symbol, { forceHistoryRefresh = false } = {}) {
  const [historyResult, points] = await Promise.all([
    fundFlowHistoryLoader.load(symbol, { force:forceHistoryRefresh })
      .then(result => ({ result, error:null }))
      .catch(error => ({ result:null, error })),
    loadRealtimeFundFlowPoints([symbol]),
  ]);
  const current = points[symbol];
  if (!historyResult.result) {
    if (!current) throw historyResult.error || new Error('Fund flow history is unavailable');
    return {
      data:[current],
      meta:{
        source:'eastmoney-realtime',
        realtime:true,
        todayOnly:true,
        realtimeUpdatedAt:current.updatedAt,
      },
    };
  }
  if (!current) return historyResult.result;
  return {
    data:mergeFundFlowHistory(historyResult.result.data, current),
    meta:{
      ...historyResult.result.meta,
      realtime:true,
      realtimeUpdatedAt:current.updatedAt,
    },
  };
}

function shanghaiDateKey(timestampMs=Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function symbolFromSecuCode(secuCode) {
  const match = String(secuCode || '').match(/^(\d{6})\.(SH|SZ)$/i);
  return match ? `${match[2].toLowerCase()}${match[1]}` : '';
}

async function loadFundamentals(symbols) {
  const aShares = [...new Set(symbols.filter(isAStockSymbol))];
  const now = Date.now();
  const missing = aShares.filter(symbol => {
    const cached = fundamentalCache.get(symbol);
    return !cached || now - cached.fetchedAt >= FUNDAMENTAL_CACHE_MS;
  });

  if (missing.length) {
    try {
      const secuCodes = missing.map(eastmoneySecuCode);
      const params = new URLSearchParams({
        reportName:'RPT_F10_FINANCE_MAINFINADATA',
        columns:'SECUCODE,REPORT_DATE,REPORT_DATE_NAME,ROEJQ,XSMLL,TOTALOPERATEREVETZ,PARENTNETPROFITTZ',
        filter:`(SECUCODE in (${secuCodes.map(code => `"${code}"`).join(',')}))`,
        pageNumber:'1', pageSize:String(Math.min(500, Math.max(20, missing.length * 8))),
        sortTypes:'-1', sortColumns:'REPORT_DATE', source:'HSF10', client:'PC',
      });
      const raw = await requestBuffer(
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?${params}`,
        { ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/' }
      );
      const payload = JSON.parse(raw.toString('utf-8'));
      const latestBySymbol = new Map();
      for (const row of payload?.result?.data || []) {
        const symbol = symbolFromSecuCode(row.SECUCODE);
        if (!symbol || latestBySymbol.has(symbol)) continue;
        latestBySymbol.set(symbol, {
          reportName:row.REPORT_DATE_NAME || String(row.REPORT_DATE || '').slice(0, 10),
          roe:numberOrNull(row.ROEJQ),
          grossMargin:numberOrNull(row.XSMLL),
          revenueGrowth:numberOrNull(row.TOTALOPERATEREVETZ),
          netProfitGrowth:numberOrNull(row.PARENTNETPROFITTZ),
        });
      }
      missing.forEach(symbol => fundamentalCache.set(symbol, {
        fetchedAt:now,
        data:latestBySymbol.get(symbol) || null,
      }));
    } catch (error) {
      console.error('Fundamental metrics error:', error.message);
    }
  }

  return Object.fromEntries(aShares.flatMap(symbol => {
    const cached = fundamentalCache.get(symbol);
    return cached?.data ? [[symbol, cached.data]] : [];
  }));
}

async function loadRealtimeValuations(symbols) {
  const aShares = [...new Set(symbols.filter(isAStockSymbol))];
  const now = Date.now();
  const missing = aShares.filter(symbol => {
    const cached = realtimeValuationCache.get(symbol);
    return !cached || now - cached.fetchedAt >= REALTIME_VALUATION_CACHE_MS;
  });

  if (missing.length) {
    try {
      const secids = missing.map(eastmoneySecId).join(',');
      const raw = await requestBuffer(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f9,f12,f13,f14,f114,f115,f124`,
        { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/' }
      );
      const rows = JSON.parse(raw.toString('utf-8'))?.data?.diff || [];
      const returned = new Set();
      for (const row of rows) {
        const symbol = `${Number(row.f13) === 1 ? 'sh' : 'sz'}${row.f12}`;
        if (!isAStockSymbol(symbol)) continue;
        returned.add(symbol);
        const rawPe = numberOrNull(row.f9);
        const rawPeStatic = numberOrNull(row.f114);
        const rawPeTtm = numberOrNull(row.f115);
        const updatedAt = numberOrNull(row.f124);
        realtimeValuationCache.set(symbol, {
          fetchedAt:now,
          data:{
            peDynamic:rawPe != null && rawPe > 0 ? rawPe / 100 : null,
            peStatic:rawPeStatic != null && rawPeStatic > 0 ? rawPeStatic / 100 : null,
            peTtm:rawPeTtm != null && rawPeTtm > 0 ? rawPeTtm / 100 : null,
            valuationDate:updatedAt ? shanghaiDateKey(updatedAt * 1000) : null,
          },
        });
      }
      missing.filter(symbol => !returned.has(symbol)).forEach(symbol => {
        realtimeValuationCache.set(symbol, {
          fetchedAt:now,
          data:{ peDynamic:null, peStatic:null, peTtm:null, valuationDate:null },
        });
      });
    } catch (error) {
      console.error('Realtime valuation error:', error.message);
    }
  }

  return Object.fromEntries(aShares.map(symbol => [symbol,
    realtimeValuationCache.get(symbol)?.data || { peDynamic:null, peStatic:null, peTtm:null, valuationDate:null },
  ]));
}

async function loadRealtimeFundFlows(symbols) {
  const aShares = [...new Set(symbols.filter(isAStockSymbol))];
  const points = await loadRealtimeFundFlowPoints(aShares);
  return Object.fromEntries(aShares.map(symbol => {
    const point = points[symbol];
    return [symbol, point ? {
      mainNetInflow:point.mainNet,
      mainNetRatio:point.mainRatio,
      superLargeNet:point.superLargeNet,
      largeNet:point.largeNet,
      flowDate:point.date,
      updatedAt:point.updatedAt,
    } : {
      mainNetInflow:null, mainNetRatio:null, superLargeNet:null, largeNet:null,
      flowDate:null, updatedAt:null,
    }];
  }));
}

async function loadRealtimeFundFlowPoints(symbols) {
  const aShares = [...new Set(symbols.filter(isAStockSymbol))];
  const now = Date.now();
  const missing = aShares.filter(symbol => {
    const cached = realtimeFundFlowCache.get(symbol);
    return !cached || now - cached.fetchedAt >= REALTIME_FUND_FLOW_CACHE_MS;
  });

  if (missing.length) {
    try {
      const secids = missing.map(eastmoneySecId).join(',');
      const fields = 'f2,f3,f12,f13,f14,f62,f66,f69,f72,f75,f78,f81,f84,f87,f124,f184';
      const raw = await requestBuffer(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=${fields}`,
        { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/' }
      );
      const rows = JSON.parse(raw.toString('utf-8'))?.data?.diff || [];
      const returned = new Set();
      for (const row of rows) {
        const symbol = `${Number(row.f13) === 1 ? 'sh' : 'sz'}${row.f12}`;
        const updatedAt = numberOrNull(row.f124);
        if (!isAStockSymbol(symbol) || !updatedAt) continue;
        returned.add(symbol);
        realtimeFundFlowCache.set(symbol, {
          fetchedAt:now,
          data:{
            date:shanghaiDateKey(updatedAt * 1000),
            mainNet:numberOrNull(row.f62),
            smallNet:numberOrNull(row.f84),
            mediumNet:numberOrNull(row.f78),
            largeNet:numberOrNull(row.f72),
            superLargeNet:numberOrNull(row.f66),
            mainRatio:numberOrNull(row.f184) == null ? null : Number(row.f184) / 100,
            smallRatio:numberOrNull(row.f87) == null ? null : Number(row.f87) / 100,
            mediumRatio:numberOrNull(row.f81) == null ? null : Number(row.f81) / 100,
            largeRatio:numberOrNull(row.f75) == null ? null : Number(row.f75) / 100,
            superLargeRatio:numberOrNull(row.f69) == null ? null : Number(row.f69) / 100,
            close:numberOrNull(row.f2) == null ? null : Number(row.f2) / 100,
            pct:numberOrNull(row.f3) == null ? null : Number(row.f3) / 100,
            updatedAt,
          },
        });
      }
      missing.filter(symbol => !returned.has(symbol)).forEach(symbol => {
        realtimeFundFlowCache.set(symbol, { fetchedAt:now, data:null });
      });
    } catch (error) {
      console.error('Realtime fund flow error:', error.message);
    }
  }

  const today = shanghaiDateKey();
  return Object.fromEntries(aShares.flatMap(symbol => {
    const point = realtimeFundFlowCache.get(symbol)?.data;
    return point?.date === today && Number.isFinite(point.mainNet) ? [[symbol, point]] : [];
  }));
}

async function proxyStockMetrics(urlObj, res) {
  const symbols = [...new Set((urlObj.searchParams.get('symbols') || '').split(',')
    .filter(symbol => /^[a-zA-Z0-9._-]+$/.test(symbol)))]
    .slice(0, 50);
  if (!symbols.length) { sendJson(res, 400, { data:{}, error:'Missing symbols' }); return; }
  const includeFundamentals = urlObj.searchParams.get('fundamentals') === '1';
  const includeValuation = urlObj.searchParams.get('valuation') === '1';
  const includeFlow = urlObj.searchParams.get('flow') === '1';
  const data = Object.fromEntries(symbols.map(symbol => [symbol, {}]));

  const [fundamentals, valuations, flow] = await Promise.all([
    includeFundamentals ? loadFundamentals(symbols).catch(() => ({})) : {},
    includeValuation ? loadRealtimeValuations(symbols).catch(() => ({})) : {},
    includeFlow ? loadRealtimeFundFlows(symbols).catch(() => ({})) : {},
  ]);
  symbols.forEach(symbol => Object.assign(data[symbol], fundamentals[symbol], valuations[symbol], flow[symbol]));

  sendJson(res, 200, { data, fetchedAt:Date.now() });
}

function reserveStockInformationCache(cache, key) {
  if (!cache.has(key) && cache.size >= STOCK_INFORMATION_CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function loadStockAnnouncements(symbol, force = false) {
  reserveStockInformationCache(stockAnnouncementCache, symbol);
  return loadCachedFundValue(stockAnnouncementCache, symbol, STOCK_ANNOUNCEMENT_CACHE_MS, async () => {
    const query = new URLSearchParams({
      sr:'-1', page_size:'100', page_index:'1', ann_type:'A', client_source:'web', stock_list:symbol.slice(2),
    });
    const raw = await requestBuffer(`https://np-anotice-stock.eastmoney.com/api/security/ann?${query}`, {
      ...UPSTREAM_HEADERS,
      Referer:`https://data.eastmoney.com/notices/stock/${symbol.slice(2)}.html`,
      Accept:'application/json,text/plain,*/*',
    }, { timeoutMs:10000, maxBytes:2 * 1024 * 1024 });
    return {
      data:normalizeAnnouncementPayload(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开公告页',
      fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockProfile(symbol, force = false) {
  reserveStockInformationCache(stockProfileCache, symbol);
  return loadCachedFundValue(stockProfileCache, symbol, STOCK_PROFILE_CACHE_MS, async () => {
    const code = `${symbol.startsWith('sh') ? 'SH' : 'SZ'}${symbol.slice(2)}`;
    const raw = await requestBuffer(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${code}`,
      { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/', Accept:'application/json,text/plain,*/*' },
      { timeoutMs:10000, maxBytes:2 * 1024 * 1024 }
    );
    return {
      data:normalizeCompanySurvey(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开公司资料',
      fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockBusinessAnalysis(symbol, force = false) {
  reserveStockInformationCache(stockBusinessAnalysisCache, symbol);
  return loadCachedFundValue(stockBusinessAnalysisCache, symbol, STOCK_BUSINESS_ANALYSIS_CACHE_MS, async () => {
    const query = new URLSearchParams({
      reportName:'RPT_F10_OP_BUSINESSANALYSIS', columns:'SECUCODE,REPORT_DATE,REPORT_NAME,BUSINESS_REVIEW,FUTURE_EXPECT',
      filter:`(SECUCODE="${eastmoneySecuCode(symbol)}")`, pageNumber:'1', pageSize:'4',
      sortColumns:'REPORT_DATE', sortTypes:'-1', source:'HSF10', client:'PC',
    });
    const raw = await requestBuffer(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${query}`, {
      ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/', Accept:'application/json,text/plain,*/*',
    }, { timeoutMs:12000, maxBytes:4 * 1024 * 1024 });
    return {
      data:normalizeBusinessAnalysisPayload(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开经营分析', fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockHolderNumber(symbol, force = false) {
  reserveStockInformationCache(stockHolderNumberCache, symbol);
  return loadCachedFundValue(stockHolderNumberCache, symbol, STOCK_HOLDER_NUMBER_CACHE_MS, async () => {
    const query = new URLSearchParams({
      reportName:'RPT_HOLDERNUMLATEST', columns:'SECURITY_CODE,END_DATE,HOLD_NOTICE_DATE,HOLDER_NUM,PRE_HOLDER_NUM,HOLDER_NUM_CHANGE,HOLDER_NUM_RATIO,INTERVAL_CHRATE,AVG_MARKET_CAP,AVG_HOLD_NUM,TOTAL_MARKET_CAP,TOTAL_A_SHARES',
      filter:`(SECURITY_CODE="${symbol.slice(2)}")`, pageNumber:'1', pageSize:'1', source:'WEB', client:'WEB',
    });
    const raw = await requestBuffer(`https://datacenter-web.eastmoney.com/api/data/v1/get?${query}`, {
      ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/', Accept:'application/json,text/plain,*/*',
    }, { timeoutMs:12000, maxBytes:512 * 1024 });
    return {
      data:normalizeHolderNumberPayload(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开股东户数', fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockFinancials(symbol, force = false) {
  reserveStockInformationCache(stockFinancialCache, symbol);
  return loadCachedFundValue(stockFinancialCache, symbol, STOCK_FINANCIAL_CACHE_MS, async () => {
    const columns = [
      'SECUCODE','REPORT_DATE','REPORT_DATE_NAME','NOTICE_DATE','EPSJB','BPS','MGJYXJJE','ROEJQ','XSMLL',
      'TOTALOPERATEREVETZ','PARENTNETPROFITTZ','TOTALOPERATEREVE','PARENTNETPROFIT',
    ].join(',');
    const query = new URLSearchParams({
      reportName:'RPT_F10_FINANCE_MAINFINADATA', columns,
      filter:`(SECUCODE="${eastmoneySecuCode(symbol)}")`,
      pageNumber:'1', pageSize:'12', sortTypes:'-1', sortColumns:'REPORT_DATE', source:'HSF10', client:'PC',
    });
    const raw = await requestBuffer(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${query}`, {
      ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/', Accept:'application/json,text/plain,*/*',
    }, { timeoutMs:10000, maxBytes:2 * 1024 * 1024 });
    return {
      data:normalizeFinancialPayload(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开财务数据',
      fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockEarningsForecasts(symbol, force = false) {
  reserveStockInformationCache(stockEarningsForecastCache, symbol);
  return loadCachedFundValue(stockEarningsForecastCache, symbol, STOCK_EARNINGS_FORECAST_CACHE_MS, async () => {
    const query = new URLSearchParams({
      reportName:'RPT_PUBLIC_OP_NEWPREDICT',
      columns:'SECURITY_CODE,NOTICE_DATE,REPORT_DATE,PREDICT_FINANCE,PREDICT_AMT_LOWER,PREDICT_AMT_UPPER,PREDICT_TYPE',
      filter:`(SECURITY_CODE="${symbol.slice(2)}")`, pageNumber:'1', pageSize:'100',
      sortColumns:'REPORT_DATE,NOTICE_DATE', sortTypes:'-1,-1', source:'WEB', client:'WEB',
    });
    const raw = await requestBuffer(`https://datacenter-web.eastmoney.com/api/data/v1/get?${query}`, {
      ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/bbsj/202603/yjyg.html', Accept:'application/json,text/plain,*/*',
    }, { timeoutMs:10000, maxBytes:2 * 1024 * 1024 });
    return {
      data:normalizeEarningsForecastPayload(JSON.parse(raw.toString('utf-8')), symbol),
      source:'东方财富公开业绩预告',
      fetchedAt:Date.now(),
    };
  }, force);
}

async function loadStockNews(symbol, force = false) {
  reserveStockInformationCache(stockNewsCache, symbol);
  return loadCachedFundValue(stockNewsCache, symbol, STOCK_NEWS_CACHE_MS, async () => {
    const url = `https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllNewsStock.php?symbol=${encodeURIComponent(symbol)}&Page=1`;
    const raw = await requestBuffer(url, {
      ...UPSTREAM_HEADERS, Referer:'https://finance.sina.com.cn/', Accept:'text/html,application/xhtml+xml',
    }, { timeoutMs:12000, maxBytes:3 * 1024 * 1024 });
    return {
      data:parseSinaStockNews(gbkDecode(raw)),
      source:'新浪财经公开个股资讯',
      fetchedAt:Date.now(),
    };
  }, force);
}

async function proxyStockInformation(urlObj, res) {
  const symbol = String(urlObj.searchParams.get('symbol') || '').toLowerCase();
  if (!isAStockSymbol(symbol)) {
    sendJson(res, 400, { error:'目前资讯财报仅支持沪深 A 股' });
    return;
  }
  const force = urlObj.searchParams.get('refresh') === '1';
  const requestedSection = String(urlObj.searchParams.get('section') || 'overview').toLowerCase();
  const sections = {
    overview:[
      ['profile', '公司简况', loadStockProfile],
      ['businessAnalysis', '经营分析', loadStockBusinessAnalysis],
      ['holderNumber', '股东户数', loadStockHolderNumber],
    ],
    financials:[['financials', '财务指标', loadStockFinancials], ['earningsForecasts', '业绩预告', loadStockEarningsForecasts]],
    events:[['announcements', '公告与财报原文', loadStockAnnouncements]],
    news:[['news', '相关新闻', loadStockNews]],
  };
  const section = Object.hasOwn(sections, requestedSection) ? requestedSection : 'overview';
  const requested = sections[section];
  const settled = await Promise.allSettled(requested.map(([, , load]) => load(symbol, force)));
  const unavailable = settled.flatMap((result, index) => result.status === 'rejected' ? [requested[index][1]] : []);
  settled.forEach((result, index) => {
    if (result.status === 'rejected') console.error(`Stock information ${requested[index][1]} error (${symbol}):`, result.reason?.message);
  });
  if (unavailable.length === settled.length) {
    sendJson(res, 502, { error:'公开资讯数据暂时不可用，请稍后重试', unavailable });
    return;
  }
  const values = Object.fromEntries(requested.map(([key], index) => [key, settled[index].status === 'fulfilled' ? settled[index].value : null]));
  const profile = values.profile;
  const businessAnalysis = values.businessAnalysis;
  const holderNumber = values.holderNumber;
  const announcements = values.announcements;
  const financials = values.financials;
  const earningsForecasts = values.earningsForecasts;
  const news = values.news;
  const announcementRows = announcements?.data || [];
  const fetchedAt = Math.max(...Object.values(values).map(value => value?.fetchedAt || 0));
  sendJson(res, 200, {
    symbol, section,
    profile:profile?.data || null,
    businessAnalysis:businessAnalysis?.data || [],
    holderNumber:holderNumber?.data || null,
    announcements:announcementRows,
    reports:announcementRows.filter(item => item.isReport),
    financials:financials?.data || [],
    earningsForecasts:earningsForecasts?.data || [],
    news:news?.data || [],
    unavailable,
    partial:Boolean(unavailable.length),
    stale:Object.values(values).some(value => value?.stale),
    fetchedAt,
    sources:{ profile:profile?.source || '', businessAnalysis:businessAnalysis?.source || '', holderNumber:holderNumber?.source || '', announcements:announcements?.source || '', financials:financials?.source || '', earningsForecasts:earningsForecasts?.source || '', news:news?.source || '' },
  });
}

function eastmoneyNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 板块行情主源与延迟镜像：push2 被风控断连时自动降级到 push2delay（约延迟 15 分钟）。
const EASTMONEY_BOARD_HOSTS = ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];

function eastmoneyBoardUrl({ fs, fields, pageSize, pageNumber = 1, host = EASTMONEY_BOARD_HOSTS[0] }) {
  return `${host}/api/qt/clist/get?` + new URLSearchParams({
    pn:String(pageNumber), pz:String(pageSize), po:'1', np:'1', fltt:'2', invt:'2', fid:'f3', fs, fields,
  });
}

async function fetchEastmoneyBoardRows({ fs, fields, pageSize }) {
  const upstreamPageSize = 100;
  const requestedRows = Math.min(Math.max(Number(pageSize) || upstreamPageSize, 1), 1000);
  const loadPage = async (pageNumber, host) => {
    const raw = await boardRequestQueue.run(() => requestBuffer(eastmoneyBoardUrl({
      fs, fields, pageSize:upstreamPageSize, pageNumber, host,
    }), {
      ...UPSTREAM_HEADERS,
      Referer:'https://quote.eastmoney.com/',
    }, { timeoutMs:9000 }));
    const payload = JSON.parse(raw.toString('utf-8'));
    if (Number(payload?.rc) !== 0 || !Array.isArray(payload?.data?.diff)) {
      throw new Error('Invalid board market payload');
    }
    return { rows:payload.data.diff, total:eastmoneyNumber(payload.data.total) || payload.data.diff.length };
  };
  const loadAllPages = async host => {
    const firstPage = await loadPage(1, host);
    const total = firstPage.total;
    const rowsToLoad = Math.min(total, requestedRows);
    const pageCount = Math.ceil(rowsToLoad / upstreamPageSize);
    if (pageCount === 1) return { rows:firstPage.rows.slice(0, rowsToLoad), total };
    const laterPages = await Promise.all(
      Array.from({ length:pageCount - 1 }, (_, index) => loadPage(index + 2, host))
    );
    return { rows:[...firstPage.rows, ...laterPages.flatMap(page => page.rows)].slice(0, rowsToLoad), total };
  };
  // push2 主源优先；任意一页断连/超时/无效响应时，整批降级到延迟镜像重试，
  // 避免"首页成功、后续分页失败"导致请求整体失败。
  try {
    return await loadAllPages(EASTMONEY_BOARD_HOSTS[0]);
  } catch (error) {
    console.error(`Board host ${EASTMONEY_BOARD_HOSTS[0]} unavailable (${error.message}), falling back to ${EASTMONEY_BOARD_HOSTS[1]}`);
    return await loadAllPages(EASTMONEY_BOARD_HOSTS[1]);
  }
}

function saveBoundedCache(cache, key, payload, maxEntries) {
  cache.delete(key);
  cache.set(key, payload);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function normalizedBoardRow(row) {
  const leaderMarket = Number(row.f141);
  const leaderCode = row.f140 == null ? '' : String(row.f140);
  return {
    code:String(row.f12 || ''), name:String(row.f14 || ''), price:eastmoneyNumber(row.f2),
    pct:eastmoneyNumber(row.f3), change:eastmoneyNumber(row.f4), turnover:eastmoneyNumber(row.f8),
    marketCap:eastmoneyNumber(row.f20), mainNetInflow:eastmoneyNumber(row.f62),
    flowPeriods:{
      today:{ mainNet:eastmoneyNumber(row.f62), mainRatio:eastmoneyNumber(row.f184) },
      '3d':{ mainNet:eastmoneyNumber(row.f267), mainRatio:eastmoneyNumber(row.f268) },
      '5d':{ mainNet:eastmoneyNumber(row.f164), mainRatio:eastmoneyNumber(row.f165) },
      '10d':{ mainNet:eastmoneyNumber(row.f174), mainRatio:eastmoneyNumber(row.f175) },
    },
    upCount:eastmoneyNumber(row.f104), downCount:eastmoneyNumber(row.f105),
    leader:{
      name:String(row.f128 || ''), code:leaderCode,
      symbol:leaderCode && (leaderMarket === 0 || leaderMarket === 1)
        ? `${leaderMarket === 1 ? 'sh' : 'sz'}${leaderCode}` : '',
      pct:eastmoneyNumber(row.f136),
    },
  };
}

function normalizedBoardStock(row) {
  const code = String(row.f12 || '');
  const market = Number(row.f13);
  const marketPrefix = market === 1 ? 'sh' : market === 0 ? 'sz' : code.startsWith('8') || code.startsWith('4') ? 'bj' : '';
  const symbol = /^\d{6}$/.test(code) && marketPrefix ? `${marketPrefix}${code}` : '';
  return {
    code, symbol, name:String(row.f14 || ''), price:eastmoneyNumber(row.f2),
    pct:eastmoneyNumber(row.f3), change:eastmoneyNumber(row.f4), volume:eastmoneyNumber(row.f5),
    amount:eastmoneyNumber(row.f6), turnover:eastmoneyNumber(row.f8), marketCap:eastmoneyNumber(row.f20),
    floatMarketCap:eastmoneyNumber(row.f21), pb:eastmoneyNumber(row.f23),
    mainNetInflow:eastmoneyNumber(row.f62), industry:String(row.f100 || ''),
  };
}

async function loadBoardList(type, force = false) {
  const boardType = BOARD_TYPES[type];
  if (!boardType) throw new Error('Invalid board type');
  const cached = boardListCache.get(type);
  if (!force && cached && Date.now() - cached.fetchedAt < BOARD_LIST_CACHE_MS) return cached;
  if (boardListRefreshes.has(type)) return boardListRefreshes.get(type);
  const refresh = (async () => {
    const { rows, total } = await fetchEastmoneyBoardRows({
      fs:boardType.fs,
      fields:'f2,f3,f4,f8,f12,f14,f20,f62,f104,f105,f128,f136,f140,f141,f184,f267,f268,f164,f165,f174,f175',
      pageSize:BOARD_LIST_PAGE_SIZE,
    });
    const data = rows.map(normalizedBoardRow).filter(item => item.code && item.name);
    const payload = { type, label:boardType.label, data, total, fetchedAt:Date.now(), truncated:total > data.length };
    saveBoundedCache(boardListCache, type, payload, Object.keys(BOARD_TYPES).length);
    return payload;
  })();
  boardListRefreshes.set(type, refresh);
  try { return await refresh; } finally { boardListRefreshes.delete(type); }
}

async function loadBoardDetail(code) {
  const cached = boardDetailCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < BOARD_DETAIL_CACHE_MS) return cached;
  if (boardDetailRefreshes.has(code)) return boardDetailRefreshes.get(code);
  const refresh = (async () => {
    const { rows, total } = await fetchEastmoneyBoardRows({
      fs:`b:${code}+f:!50`,
      fields:'f2,f3,f4,f5,f6,f8,f12,f13,f14,f20,f21,f23,f62,f100',
      pageSize:BOARD_COMPONENT_PAGE_SIZE,
    });
    const stocks = rows.map(normalizedBoardStock).filter(item => item.code && item.name);
    const payload = {
      code, total, stocks, fetchedAt:Date.now(), truncated:total > stocks.length,
    };
    saveBoundedCache(boardDetailCache, code, payload, 36);
    return payload;
  })();
  boardDetailRefreshes.set(code, refresh);
  try { return await refresh; } finally { boardDetailRefreshes.delete(code); }
}

function boardInfoValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text !== '--' ? text : '';
}

async function loadStockBoards(symbol) {
  if (!isAStockSymbol(symbol)) return { symbol, boards:[], fetchedAt:Date.now() };
  const cached = stockBoardCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < STOCK_BOARD_CACHE_MS) return cached;
  if (stockBoardRefreshes.has(symbol)) return stockBoardRefreshes.get(symbol);
  const refresh = (async () => {
    const code = `${symbol.startsWith('sh') ? 'SH' : 'SZ'}${symbol.slice(2)}`;
    const raw = await boardRequestQueue.run(() => requestBuffer(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${code}`,
      { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/' },
      { timeoutMs:9000 }
    ));
    const info = JSON.parse(raw.toString('utf-8'))?.jbzl || {};
    const candidates = [
      ['行业', boardInfoValue(info.sshy)],
      ['证监会行业', boardInfoValue(info.sszjhhy)],
      ['市场板块', boardInfoValue(info.zqlb)],
      ['地域', boardInfoValue(info.qy)],
    ];
    const seen = new Set();
    const boards = candidates.filter(([, name]) => {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    }).map(([kind, name]) => ({ kind, name }));
    const payload = { symbol, boards, fetchedAt:Date.now() };
    saveBoundedCache(stockBoardCache, symbol, payload, 240);
    return payload;
  })();
  stockBoardRefreshes.set(symbol, refresh);
  try { return await refresh; } finally { stockBoardRefreshes.delete(symbol); }
}

async function proxyBoardList(urlObj, res) {
  const type = urlObj.searchParams.get('type') || 'industry';
  if (!BOARD_TYPES[type]) { sendJson(res, 400, { data:[], error:'Invalid board type' }); return; }
  try {
    sendJson(res, 200, await loadBoardList(type, urlObj.searchParams.has('refresh')));
  } catch (error) {
    console.error(`Board list error (${type}):`, error.message);
    sendJson(res, 502, { data:[], error:'板块行情暂时不可用' });
  }
}

async function proxyBoardDetail(urlObj, res) {
  const code = (urlObj.searchParams.get('code') || '').toUpperCase();
  if (!/^BK\d{4,6}$/.test(code)) { sendJson(res, 400, { stocks:[], error:'Invalid board code' }); return; }
  try {
    sendJson(res, 200, await loadBoardDetail(code));
  } catch (error) {
    console.error(`Board detail error (${code}):`, error.message);
    sendJson(res, 502, { stocks:[], error:'板块成分股暂时不可用' });
  }
}

async function proxyStockBoards(urlObj, res) {
  const symbol = urlObj.searchParams.get('sym') || '';
  if (!isAStockSymbol(symbol)) { sendJson(res, 400, { boards:[], error:'仅支持普通 A 股板块信息' }); return; }
  try {
    sendJson(res, 200, await loadStockBoards(symbol));
  } catch (error) {
    console.error(`Stock board error (${symbol}):`, error.message);
    sendJson(res, 502, { boards:[], error:'个股板块信息暂时不可用' });
  }
}

async function proxyFundFlowHistory(urlObj, res) {
  const symbol = urlObj.searchParams.get('sym') || '';
  if (!isAStockSymbol(symbol)) { sendJson(res, 400, { data:[], error:'主力资金目前仅支持普通 A 股' }); return; }
  try {
    const result = await loadFundFlowHistoryResult(symbol, {
      forceHistoryRefresh:urlObj.searchParams.get('refresh') === '1',
    });
    sendJson(res, 200, { ...result, streak:consecutiveFlowDays(result.data), fetchedAt:Date.now() });
  } catch (error) {
    console.error(`Fund flow history error (${symbol}):`, error.message);
    sendJson(res, 502, { data:[], error:'主力资金数据暂时拿不到，请稍后重试' });
  }
}

function capitalFlowSecId(kind, code) {
  if (kind === 'stock' && isAStockSymbol(code)) return eastmoneySecId(code);
  if (kind === 'board' && /^BK\d{4,6}$/.test(code)) return `90.${code}`;
  return '';
}

async function requestEastmoneyFlowJson(pathname, params, { historical = false } = {}) {
  const hosts = historical
    ? ['https://push2his.eastmoney.com', 'https://push2his.eastmoney.com']
    : ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
  let lastError;
  for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
    const host = hosts[hostIndex];
    try {
      const raw = await boardRequestQueue.run(() => requestBuffer(
        `${host}${pathname}?${new URLSearchParams(params)}`,
        { ...UPSTREAM_HEADERS, Referer:historical ? 'https://quote.eastmoney.com/' : 'https://data.eastmoney.com/' },
        { timeoutMs:9000 }
      ));
      const payload = JSON.parse(raw.toString('utf-8'));
      if (Number(payload?.rc) !== 0 || !payload?.data) throw new Error('Invalid capital flow payload');
      return payload;
    } catch (error) {
      lastError = error;
      if (historical && hostIndex + 1 < hosts.length) await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  throw lastError || new Error('Capital flow upstream is unavailable');
}

async function fetchLimitPool(side, date) {
  const definition = side === 'up'
    ? { pathname:'/getTopicZTPool', sort:'fbt:asc' }
    : { pathname:'/getTopicDTPool', sort:'fund:asc' };
  const query = new URLSearchParams({
    ut:'7eea3edcaed734bea9cbfc24409ed989', dpt:'wz.ztzt', Pageindex:'0', pagesize:'10000',
    sort:definition.sort, date,
  });
  const raw = await boardRequestQueue.run(() => requestBuffer(
    `https://push2ex.eastmoney.com${definition.pathname}?${query}`,
    { ...UPSTREAM_HEADERS, Referer:'https://quote.eastmoney.com/' },
    { timeoutMs:9000, maxBytes:4 * 1024 * 1024 }
  ));
  const payload = JSON.parse(raw.toString('utf-8'));
  if (Number(payload?.rc) !== 0) throw new Error('Invalid limit pool payload');
  return normalizeLimitPoolPayload(payload, side, date);
}

async function loadLimitPools(force = false) {
  const date = shanghaiDateKey().replace(/-/g, '');
  const payload = await loadCachedFundValue(limitPoolCache, date, LIMIT_POOL_CACHE_MS, async () => {
    const [limitUp, limitDown] = await Promise.all([fetchLimitPool('up', date), fetchLimitPool('down', date)]);
    return { date, limitUp, limitDown, fetchedAt:Date.now() };
  }, force);
  while (limitPoolCache.size > 8) limitPoolCache.delete(limitPoolCache.keys().next().value);
  return payload;
}

async function proxyLimitPools(urlObj, res) {
  try {
    sendJson(res, 200, await loadLimitPools(urlObj.searchParams.get('refresh') === '1'));
  } catch (error) {
    console.error('Limit pools error:', error.message);
    sendJson(res, 502, { limitUp:{ data:[], total:0 }, limitDown:{ data:[], total:0 }, error:'涨跌停数据暂时不可用' });
  }
}

async function fetchCapitalFlowRankings({ scope, type, market, period, direction, limit }) {
  const definition = FLOW_PERIODS[period];
  const fs = scope === 'board' ? BOARD_TYPES[type]?.fs : STOCK_FLOW_MARKETS[market];
  if (!definition || !fs) throw new Error('Invalid capital flow ranking parameters');
  const payload = await requestEastmoneyFlowJson('/api/qt/clist/get', {
    pn:'1', pz:String(limit), po:direction === 'out' ? '0' : '1', np:'1', fltt:'2', invt:'2',
    fid:definition.sortField, fs, fields:flowRankingFields(period),
  });
  const rows = payload.data.diff || [];
  const data = rows.map(row => normalizeFlowRankingRow(row, { period, scope })).filter(item =>
    item.code && item.name && (scope === 'board' || item.symbol)
  );
  return { scope, type:scope === 'board' ? type : undefined, market:scope === 'stock' ? market : undefined,
    period, direction, data, total:numberOrNull(payload.data.total) || data.length, fetchedAt:Date.now() };
}

async function proxyCapitalFlowRankings(urlObj, res) {
  const scope = urlObj.searchParams.get('scope') || 'stock';
  const type = urlObj.searchParams.get('type') || 'industry';
  const market = urlObj.searchParams.get('market') || 'all';
  const period = urlObj.searchParams.get('period') || 'today';
  const direction = urlObj.searchParams.get('direction') || 'in';
  const limit = Math.min(100, Math.max(5, Number(urlObj.searchParams.get('limit')) || 30));
  if (!['stock','board'].includes(scope) || !FLOW_PERIODS[period] || !['in','out'].includes(direction) ||
      (scope === 'board' && !BOARD_TYPES[type]) || (scope === 'stock' && !STOCK_FLOW_MARKETS[market])) {
    sendJson(res, 400, { data:[], error:'资金排行参数无效' }); return;
  }
  const key = [scope, type, market, period, direction, limit].join(':');
  try {
    const payload = await loadCachedFundValue(capitalFlowRankingCache, key, CAPITAL_FLOW_RANKING_CACHE_MS,
      () => fetchCapitalFlowRankings({ scope, type, market, period, direction, limit }),
      urlObj.searchParams.get('refresh') === '1');
    while (capitalFlowRankingCache.size > 240) capitalFlowRankingCache.delete(capitalFlowRankingCache.keys().next().value);
    sendJson(res, 200, payload);
  } catch (error) {
    console.error('Capital flow ranking error:', error.message);
    sendJson(res, 502, { data:[], error:'资金流向排行暂时不可用' });
  }
}

async function fetchCapitalFlowIntraday(secid) {
  const payload = await requestEastmoneyFlowJson('/api/qt/stock/fflow/kline/get', {
    secid, lmt:'0', klt:'1', fields1:'f1,f2,f3,f7', fields2:'f51,f52,f53,f54,f55,f56',
  });
  return { ...parseIntradayFlowPayload(payload), fetchedAt:Date.now() };
}

async function loadCapitalFlowIntraday(secid, force = false) {
  const value = await loadCachedFundValue(capitalFlowIntradayCache, secid, CAPITAL_FLOW_INTRADAY_CACHE_MS,
    () => fetchCapitalFlowIntraday(secid), force);
  while (capitalFlowIntradayCache.size > 500) capitalFlowIntradayCache.delete(capitalFlowIntradayCache.keys().next().value);
  return value;
}

async function fetchCapitalFlowHistory(secid) {
  const payload = await requestEastmoneyFlowJson('/api/qt/stock/fflow/daykline/get', {
    secid, lmt:'120', klt:'101', fields1:'f1,f2,f3,f7',
    fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63',
  }, { historical:true });
  const data = parseFundFlowHistoryPayload(payload);
  return { code:String(payload.data?.code || ''), name:String(payload.data?.name || ''), data,
    streak:consecutiveFlowDays(data), fetchedAt:Date.now() };
}

async function loadCapitalFlowHistory(secid, force = false) {
  return loadCachedFundValue(capitalFlowHistoryCache, secid, CAPITAL_FLOW_HISTORY_CACHE_MS,
    () => fundFlowHistoryRequestQueue.run(() => fetchCapitalFlowHistory(secid)), force);
}

async function proxyCapitalFlowMarket(urlObj, res) {
  const force = urlObj.searchParams.get('refresh') === '1';
  const markets = [
    { key:'sh', name:'沪市', secid:'1.000001' },
    { key:'sz', name:'深市', secid:'0.399001' },
  ];
  const settled = await Promise.all(markets.map(async market => {
    const [intraday, history] = await Promise.allSettled([
      loadCapitalFlowIntraday(market.secid, force), loadCapitalFlowHistory(market.secid, force),
    ]);
    return {
      ...market,
      intraday:intraday.status === 'fulfilled' ? intraday.value.data : [],
      history:history.status === 'fulfilled' ? history.value.data : [],
      stale:Boolean(intraday.value?.stale || history.value?.stale),
      unavailable:[intraday.status === 'rejected' ? 'intraday' : '', history.status === 'rejected' ? 'history' : ''].filter(Boolean),
    };
  }));
  if (settled.every(market => !market.intraday.length && !market.history.length)) {
    sendJson(res, 502, { markets:[], error:'大盘资金流向暂时不可用' }); return;
  }
  sendJson(res, 200, {
    markets:settled,
    combined:{
      name:'沪深两市',
      intraday:mergeFlowSeries(settled.map(market => market.intraday), 'time'),
      history:mergeFlowSeries(settled.map(market => market.history), 'date'),
    },
    partial:settled.some(market => market.unavailable.length), fetchedAt:Date.now(),
  });
}

function latestMarketFlowPoint(rows) {
  const points = Array.isArray(rows) ? rows : [];
  return points.length ? points[points.length - 1] : null;
}

async function fetchMainlandMarketOverview(code, force = false) {
  const definition = MAINLAND_MARKET_INDEXES[code];
  if (!definition) throw new Error('Unsupported mainland market index');
  const quote = await requestEastmoneyFlowJson('/api/qt/stock/get', {
    secid:definition.secid,
    fields:'f43,f44,f45,f46,f47,f48,f57,f58,f60,f106,f107,f113,f114,f115,f116,f117,f124',
  });
  const raw = quote.data || {};
  const flowMarkets = [
    { key:'sh', name:'沪市', secid:'1.000001' },
    { key:'sz', name:'深市', secid:'0.399001' },
  ];
  const [flowResult, boardResult] = await Promise.allSettled([
    Promise.all(flowMarkets.map(async market => ({
      ...market,
      flow:latestMarketFlowPoint((await loadCapitalFlowIntraday(market.secid, force)).data),
    }))),
    loadBoardList('industry', force),
  ]);
  const flows = flowResult.status === 'fulfilled' ? flowResult.value : [];
  const combinedFlow = flows.reduce((total, market) => {
    const flow = market.flow || {};
    for (const key of ['mainNet','smallNet','mediumNet','largeNet','superLargeNet']) {
      const value = numberOrNull(flow[key]);
      if (value != null) total[key] = (total[key] || 0) + value;
    }
    return total;
  }, {});
  const boardRows = boardResult.status === 'fulfilled' ? boardResult.value.data : [];
  const comparableBoards = boardRows.filter(item => Number.isFinite(item.pct));
  const flowBoards = boardRows.filter(item => Number.isFinite(item.mainNetInflow));
  return {
    code, name:String(raw.f58 || definition.name),
    breadth:{
      rising:numberOrNull(raw.f113), falling:numberOrNull(raw.f114), flat:numberOrNull(raw.f115),
      limitUp:numberOrNull(raw.f106), limitDown:numberOrNull(raw.f107),
    },
    trading:{
      volume:numberOrNull(raw.f47), amount:numberOrNull(raw.f48),
      totalMarketCap:numberOrNull(raw.f116), floatMarketCap:numberOrNull(raw.f117),
    },
    funds:{
      combined:Object.keys(combinedFlow).length ? combinedFlow : null,
      markets:flows.map(market => ({ key:market.key, name:market.name, ...(market.flow || {}) })),
    },
    sectors:{
      rising:[...comparableBoards].sort((left, right) => right.pct - left.pct).slice(0, 3),
      falling:[...comparableBoards].sort((left, right) => left.pct - right.pct).slice(0, 3),
      inflow:[...flowBoards].sort((left, right) => right.mainNetInflow - left.mainNetInflow).slice(0, 3),
      outflow:[...flowBoards].sort((left, right) => left.mainNetInflow - right.mainNetInflow).slice(0, 3),
    },
    unavailable:[
      flowResult.status === 'rejected' ? '沪深资金流向' : '',
      boardResult.status === 'rejected' ? '行业强弱与行业资金' : '',
    ].filter(Boolean),
    partial:flowResult.status === 'rejected' || boardResult.status === 'rejected',
    fetchedAt:Date.now(),
  };
}

async function proxyMainlandMarketOverview(urlObj, res) {
  const code = String(urlObj.searchParams.get('code') || '');
  if (!MAINLAND_MARKET_INDEXES[code]) {
    sendJson(res, 400, { error:'仅支持沪深主要指数的市场总览' }); return;
  }
  try {
    const payload = await loadCachedFundValue(marketOverviewCache, code, MARKET_OVERVIEW_CACHE_MS,
      () => fetchMainlandMarketOverview(code, urlObj.searchParams.get('refresh') === '1'),
      urlObj.searchParams.get('refresh') === '1');
    while (marketOverviewCache.size > 10) marketOverviewCache.delete(marketOverviewCache.keys().next().value);
    sendJson(res, 200, payload);
  } catch (error) {
    console.error(`Mainland market overview error (${code}):`, error.message);
    sendJson(res, 502, { error:'大盘总览暂时不可用' });
  }
}

async function proxyCapitalFlowHistory(urlObj, res) {
  const kind = urlObj.searchParams.get('kind') || 'stock';
  const code = urlObj.searchParams.get('code') || '';
  const secid = capitalFlowSecId(kind, code);
  if (!secid) { sendJson(res, 400, { data:[], error:'资金历史参数无效' }); return; }
  try {
    if (kind === 'stock') {
      const result = await loadFundFlowHistoryResult(code, { forceHistoryRefresh:urlObj.searchParams.get('refresh') === '1' });
      sendJson(res, 200, { ...result, streak:consecutiveFlowDays(result.data), fetchedAt:Date.now() });
      return;
    }
    const result = await boardFundFlowHistoryLoader.load(`board:${code}`, {
      force:urlObj.searchParams.get('refresh') === '1',
    });
    sendJson(res, 200, { ...result, code, streak:consecutiveFlowDays(result.data), fetchedAt:Date.now() });
  } catch (error) {
    console.error(`Capital flow history error (${kind}:${code}):`, error.message);
    sendJson(res, 502, { data:[], error:'资金历史暂时不可用' });
  }
}

async function proxyCapitalFlowIntraday(urlObj, res) {
  const kind = urlObj.searchParams.get('kind') || 'stock';
  const code = urlObj.searchParams.get('code') || '';
  const secid = capitalFlowSecId(kind, code);
  if (!secid) { sendJson(res, 400, { data:[], error:'日内资金参数无效' }); return; }
  try {
    sendJson(res, 200, await loadCapitalFlowIntraday(secid, urlObj.searchParams.get('refresh') === '1'));
  } catch (error) {
    console.error(`Capital flow intraday error (${kind}:${code}):`, error.message);
    sendJson(res, 502, { data:[], error:'日内资金流向暂时不可用' });
  }
}

async function requestSinaText(url) {
  const buffer = await requestBuffer(url, {
    ...UPSTREAM_HEADERS,
    Referer:'https://finance.sina.com.cn/',
    Accept:'text/plain,*/*;q=0.8',
  }, { timeoutMs:9000 });
  if (buffer.length > 2 * 1024 * 1024) throw new Error('Sina payload is too large');
  return gbkDecode(buffer);
}

async function loadDerivativesQuotes(force = false) {
  const cachedAt = Math.max(0, ...[...derivativesQuoteCache.values()].map(item => Number(item.cachedAt) || 0));
  if (!force && derivativesQuoteCache.size && Date.now() - cachedAt < DERIVATIVES_QUOTE_CACHE_MS) {
    const cffex = ['IF','IH','IC','IM'].map(code => derivativesQuoteCache.get(`cffex:${code}`)?.value).filter(Boolean);
    const us = ['ES','NQ','YM'].map(code => derivativesQuoteCache.get(`us:${code}`)?.value).filter(Boolean);
    const partial = cffex.length < 4 || us.length < 3 || [...derivativesQuoteCache.values()].some(item =>
      Date.now() - (Number(item.cachedAt) || 0) >= DERIVATIVES_QUOTE_CACHE_MS
    );
    return {
      cffex, us, fetchedAt:cachedAt, partial,
    };
  }
  if (derivativesQuoteRefreshPromise) return derivativesQuoteRefreshPromise;
  derivativesQuoteRefreshPromise = (async () => {
    const cffexRequests = Object.entries(CFFEX_NODES).map(async ([code, node]) => {
      const query = new URLSearchParams({ page:'1', num:'10', sort:'position', asc:'0', node, base:'futures' });
      const buffer = await requestBuffer(
        `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQFuturesData?${query}`,
        { ...UPSTREAM_HEADERS, Referer:'https://vip.stock.finance.sina.com.cn/' },
        { timeoutMs:9000 }
      );
      if (buffer.length > 1024 * 1024) throw new Error('CFFEX quote payload is too large');
      const rows = JSON.parse(buffer.toString('utf-8'));
      return { code, row:Array.isArray(rows) ? rows.find(item => item.symbol === `${code}0`) || rows[0] : null };
    });
    const [spotsResult, usResult, ...cffexResults] = await Promise.allSettled([
      requestSinaText(`https://hq.sinajs.cn/list=${Object.values(CFFEX_PRODUCTS).map(item => item.spotSymbol).join(',')}`),
      requestSinaText('https://hq.sinajs.cn/list=hf_ES,hf_NQ,hf_YM'),
      ...cffexRequests,
    ]);
    const spots = spotsResult.status === 'fulfilled' ? parseSinaSpotIndexes(spotsResult.value) : {};
    let freshCount = 0;
    cffexResults.forEach(result => {
      if (result.status !== 'fulfilled') return;
      const value = normalizeCffexFuture(result.value.row, spots[result.value.code]);
      if (!value) return;
      derivativesQuoteCache.set(`cffex:${value.code}`, { value, cachedAt:Date.now() });
      freshCount += 1;
    });
    if (usResult.status === 'fulfilled') {
      parseSinaGlobalFutures(usResult.value).forEach(value => {
        derivativesQuoteCache.set(`us:${value.code}`, { value, cachedAt:Date.now() });
        freshCount += 1;
      });
    }
    const cffex = ['IF','IH','IC','IM'].map(code => derivativesQuoteCache.get(`cffex:${code}`)?.value).filter(Boolean);
    const us = ['ES','NQ','YM'].map(code => derivativesQuoteCache.get(`us:${code}`)?.value).filter(Boolean);
    if (!cffex.length && !us.length) throw new Error('Derivative quotes are unavailable');
    return {
      cffex, us, fetchedAt:Date.now(),
      partial:freshCount < 7 || spotsResult.status === 'rejected',
    };
  })();
  try { return await derivativesQuoteRefreshPromise; }
  finally { derivativesQuoteRefreshPromise = null; }
}

async function loadDerivativesNews(force = false) {
  return loadCachedFundValue(derivativesNewsCache, 'overview', DERIVATIVES_NEWS_CACHE_MS, async () => {
    const [futuresResult, usResult] = await Promise.allSettled([
      requestBuffer('https://qhweb.eastmoney.com/kuaixunc/page?timestamp=0', {
        ...UPSTREAM_HEADERS, Referer:'https://qhweb.eastmoney.com/kuaixun',
      }, { timeoutMs:10000 }),
      requestBuffer('https://newsapi.eastmoney.com/kuaixun/v1/getlist_105_ajaxResult_100_1_.html', {
        ...UPSTREAM_HEADERS, Referer:'https://kuaixun.eastmoney.com/',
      }, { timeoutMs:10000 }),
    ]);
    const futures = futuresResult.status === 'fulfilled' && futuresResult.value.length <= 2 * 1024 * 1024
      ? parseFuturesFlashHtml(futuresResult.value.toString('utf-8'), 14) : [];
    const us = usResult.status === 'fulfilled' && usResult.value.length <= 3 * 1024 * 1024
      ? parseEastmoneyFastNews(usResult.value.toString('utf-8'), { limit:14, keywords:US_NEWS_KEYWORDS }) : [];
    if (!futures.length && !us.length) throw new Error('Derivative news is unavailable');
    return { futures, us, fetchedAt:Date.now(), partial:!futures.length || !us.length };
  }, force);
}

async function proxyDerivativesOverview(urlObj, res) {
  const force = urlObj.searchParams.get('refresh') === '1';
  const [quotesResult, newsResult] = await Promise.allSettled([
    loadDerivativesQuotes(force), loadDerivativesNews(force),
  ]);
  if (quotesResult.status === 'rejected' && newsResult.status === 'rejected') {
    console.error('Derivatives overview error:', quotesResult.reason?.message, newsResult.reason?.message);
    sendJson(res, 502, { cffex:[], us:[], futuresNews:[], usNews:[], error:'期指与夜盘数据暂时不可用' });
    return;
  }
  const quotes = quotesResult.status === 'fulfilled' ? quotesResult.value : { cffex:[], us:[], partial:true };
  const news = newsResult.status === 'fulfilled' ? newsResult.value : { futures:[], us:[], partial:true };
  sendJson(res, 200, {
    cffex:quotes.cffex, us:quotes.us,
    futuresNews:news.futures, usNews:news.us,
    partial:Boolean(quotes.partial || news.partial || quotesResult.status === 'rejected' || newsResult.status === 'rejected'),
    fetchedAt:Math.max(Number(quotes.fetchedAt) || 0, Number(news.fetchedAt) || 0, Date.now()),
    sources:{ quotes:'新浪财经公开行情', news:'东方财富期货快讯 / 全球股市快讯' },
  });
}

function parseTencentIndexes(buffer) {
  const text = gbkDecode(buffer);
  return GLOBAL_TENCENT_INDEXES.map(([symbol, code]) => {
    const match = text.match(new RegExp(`v_${symbol}="([^"]*)"`));
    if (!match) return null;
    const fields = match[1].split('~');
    return {
      code,
      price: Number(fields[3]), prevClose: Number(fields[4]), open: Number(fields[5]),
      change: Number(fields[31]), pct: Number(fields[32]),
      high: Number(fields[33]), low: Number(fields[34]), updated: fields[30] || '',
    };
  }).filter(Boolean);
}

function parseSinaIndexes(buffer) {
  const text = gbkDecode(buffer);
  return GLOBAL_SINA_INDEXES.map(([symbol, code]) => {
    const match = text.match(new RegExp(`hq_str_${symbol}="([^"]*)"`));
    if (!match || !match[1]) return null;
    const fields = match[1].split(',');
    const [, priceRaw, changeRaw, pctRaw] = fields;
    const price = Number(priceRaw), change = Number(changeRaw);
    const optionalNumber = value => value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    const prevClose = optionalNumber(fields[9]);
    return {
      code, price, change, pct: Number(pctRaw),
      prevClose: prevClose ?? price - change,
      open: optionalNumber(fields[8]), high: optionalNumber(fields[10]), low: optionalNumber(fields[11]),
      updated: fields[6] && fields[7] ? `${fields[6]} ${fields[7]}` : '',
    };
  }).filter(Boolean);
}

async function loadGlobalMarkets() {
  if (globalMarketSnapshot && Date.now() - globalMarketSnapshot.fetchedAt < GLOBAL_MARKET_CACHE_MS) {
    return globalMarketSnapshot;
  }
  if (globalMarketRefreshPromise) return globalMarketRefreshPromise;

  globalMarketRefreshPromise = (async () => {
    const tencentSymbols = GLOBAL_TENCENT_INDEXES.map(([symbol]) => symbol).join(',');
    const sinaSymbols = GLOBAL_SINA_INDEXES.map(([symbol]) => symbol).join(',');
    const requests = await Promise.allSettled([
      requestBuffer(`https://qt.gtimg.cn/q=${tencentSymbols}`, UPSTREAM_HEADERS),
      requestBuffer(`https://hq.sinajs.cn/list=${sinaSymbols}`, {
        ...UPSTREAM_HEADERS,
        Referer: 'https://finance.sina.com.cn',
      }),
    ]);
    const freshData = [];
    if (requests[0].status === 'fulfilled') freshData.push(...parseTencentIndexes(requests[0].value));
    if (requests[1].status === 'fulfilled') freshData.push(...parseSinaIndexes(requests[1].value));
    freshData.forEach(item => globalMarketCache.set(item.code, item));
    const codeOrder = [...GLOBAL_TENCENT_INDEXES, ...GLOBAL_SINA_INDEXES].map(([, code]) => code);
    const data = codeOrder.map(code => globalMarketCache.get(code)).filter(Boolean);
    if (!data.length) throw new Error('Global market data unavailable');
    globalMarketSnapshot = {
      data,
      fetchedAt: Date.now(),
      partial: requests.some(request => request.status === 'rejected') || freshData.length < codeOrder.length,
    };
    return globalMarketSnapshot;
  })();

  try {
    return await globalMarketRefreshPromise;
  } finally {
    globalMarketRefreshPromise = null;
  }
}

async function proxyGlobalMarkets(res) {
  try {
    const payload = await loadGlobalMarkets();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(payload));
  } catch (_) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ data: [] }));
  }
}

async function loadIpoCalendar() {
  if (ipoCache && Date.now() - ipoCache.fetchedAt < IPO_CACHE_MS) return ipoCache;
  if (ipoRefreshPromise) return ipoRefreshPromise;
  ipoRefreshPromise = (async () => {
    // The calendar endpoint carries the public offering fields used by the expanded
    // detail card. Asking for ALL lets the upstream add newly available public
    // fields without requiring a release here; only the allowlisted fields below
    // are returned to the browser.
    const columns = 'ALL';
    const baseUrl = 'https://datacenter-web.eastmoney.com/api/data/v1/get?';
    const stockUrl = baseUrl + new URLSearchParams({
      reportName:'RPTA_APP_IPOAPPLY', columns, pageNumber:'1', pageSize:'100',
      sortColumns:'APPLY_DATE', sortTypes:'-1', source:'WEB', client:'WEB',
    });
    const bondUrl = baseUrl + new URLSearchParams({
      reportName:'RPT_BOND_CB_LIST', columns, pageNumber:'1', pageSize:'100',
      sortColumns:'PUBLIC_START_DATE,SECURITY_CODE', sortTypes:'-1,1', source:'WEB', client:'WEB',
    });
    const [stockResult, bondResult] = await Promise.allSettled([
      requestBuffer(stockUrl, { ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/' }),
      requestBuffer(bondUrl, { ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/xg/xg/?mkt=kzz' }),
    ]);
    const rowsFrom = (result, label) => {
      if (result.status === 'rejected') {
        console.warn(`IPO ${label} calendar error:`, result.reason?.message || result.reason);
        return [];
      }
      try {
        return JSON.parse(result.value.toString('utf-8'))?.result?.data || [];
      } catch (error) {
        console.warn(`IPO ${label} calendar error:`, error.message);
        return [];
      }
    };
    const stockRows = rowsFrom(stockResult, 'stock');
    const bondRows = rowsFrom(bondResult, 'bond');
    const today = new Date(); today.setHours(0,0,0,0);
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - 14);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 60);
    const stocks = stockRows.map(row => ({
      type:'stock', code:row.SECURITY_CODE, name:row.SECURITY_NAME, applyCode:row.APPLY_CODE,
      applyDate:row.APPLY_DATE, listingDate:row.LISTING_DATE, ballotDate:row.BALLOT_NUM_DATE,
      price:row.ISSUE_PRICE, upperLimit:row.ONLINE_APPLY_UPPER,
      requiredMarketCap:row.TOP_APPLY_MARKETCAP, market:row.TRADE_MARKET,
      board:row.MARKET_TYPE, issueShares:row.ISSUE_NUM, industry:row.INDUSTRY_NAME,
      onlineIssueShares:row.ONLINE_ISSUE_NUM, onlineApplyLower:row.ONLINE_APPLY_LOWER,
      onlineFundUpper:row.ONLINE_FUND_UPPER, ballotShares:row.EACHBALLOT_SHARES,
      issuePe:row.AFTER_ISSUE_PE, industryPe:row.INDUSTRY_PE_NEW ?? row.INDUSTRY_PE,
      totalRaiseFunds:row.TOTAL_RAISE_FUNDS ?? row.PREDICT_RAISE_FUNDS,
      issueWay:row.ISSUE_WAY_EXPLAIN || row.ISSUE_WAY,
      recommendOrg:row.RECOMMEND_ORG, underwriterOrg:row.UNDERWRITER_ORG,
      companyName:row.SECURITY_NAME_FULL, mainBusiness:row.MAIN_BUSINESS,
      assignDate:row.ASSIGN_DATE, onlinePayDate:row.ONLINE_PAY_DATE,
      ballotPayDate:row.BALLOT_PAY_DATE, marketCapConfirmDate:row.MARKET_CAP_CONFIRMDATE,
      totalShares:row.TOTAL_SHARES,
    }));
    const bonds = bondRows.map(row => ({
      type:'bond', code:row.SECURITY_CODE, name:row.SECURITY_NAME_ABBR, applyCode:row.CORRECODE,
      applyDate:row.PUBLIC_START_DATE, listingDate:row.LISTING_DATE, ballotDate:row.BOND_START_DATE,
      price:row.ISSUE_PRICE, upperLimit:row.ONLINE_GENERAL_AAU, market:row.TRADE_MARKET,
      bondIssueScale:row.ACTUAL_ISSUE_SCALE, rating:row.RATING,
      underlyingStockCode:row.CONVERT_STOCK_CODE, underlyingStockName:row.SECURITY_SHORT_NAME,
      transferPrice:row.INITIAL_TRANSFER_PRICE, issueWay:row.PARAM_NAME, issueRemark:row.REMARK,
    }));
    const data = [...stocks, ...bonds].filter(item => {
      const date = new Date(item.applyDate);
      return Number.isFinite(date.getTime()) && date >= minDate && date <= maxDate;
    }).sort((a,b) => new Date(b.applyDate) - new Date(a.applyDate) || String(a.type).localeCompare(String(b.type)) || String(a.code).localeCompare(String(b.code)));
    if (!data.length) throw new Error('IPO calendar is empty');
    ipoCache = { data, fetchedAt:Date.now() };
    return ipoCache;
  })();
  try { return await ipoRefreshPromise; } finally { ipoRefreshPromise = null; }
}

async function proxyIpoCalendar(res) {
  try {
    const payload = await loadIpoCalendar();
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error('IPO calendar error:', error.message);
    res.writeHead(502, { 'Content-Type':'application/json; charset=utf-8' });
    res.end(JSON.stringify({ data:[], error:'打新数据暂时不可用' }));
  }
}

function fundDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fundOneYearAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return fundDateKey(date);
}

function allowFundRequest(req, res) {
  const now = Date.now();
  if (fundRateLimitBuckets.size > 1000) {
    for (const [key, value] of fundRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) fundRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = fundRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    fundRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= FUND_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'基金行情请求过于频繁，请稍后再试' }));
  return false;
}

function allowCapitalFlowRequest(req, res) {
  const now = Date.now();
  if (capitalFlowRateLimitBuckets.size > 1000) {
    for (const [key, value] of capitalFlowRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) capitalFlowRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = capitalFlowRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    capitalFlowRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= CAPITAL_FLOW_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'资金流向请求过于频繁，请稍后再试' }));
  return false;
}

function allowOrderBookRequest(req, res) {
  const now = Date.now();
  if (orderBookRateLimitBuckets.size > 1000) {
    for (const [key, value] of orderBookRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) orderBookRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = orderBookRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    orderBookRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= ORDER_BOOK_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'盘口请求过于频繁，请稍后再试' }));
  return false;
}

function allowLimitPoolRequest(req, res) {
  const now = Date.now();
  if (limitPoolRateLimitBuckets.size > 1000) {
    for (const [key, value] of limitPoolRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) limitPoolRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = limitPoolRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    limitPoolRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= LIMIT_POOL_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'涨跌停数据请求过于频繁，请稍后再试' }));
  return false;
}

function allowDerivativesRequest(req, res) {
  const now = Date.now();
  if (derivativesRateLimitBuckets.size > 1000) {
    for (const [key, value] of derivativesRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) derivativesRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = derivativesRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    derivativesRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= DERIVATIVES_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'期指与夜盘请求过于频繁，请稍后再试' }));
  return false;
}

function allowStockInformationRequest(req, res) {
  const now = Date.now();
  if (stockInformationRateLimitBuckets.size > 1000) {
    for (const [key, value] of stockInformationRateLimitBuckets) {
      if (now - value.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) stockInformationRateLimitBuckets.delete(key);
    }
  }
  const address = String(req.socket?.remoteAddress || 'unknown').slice(0, 100);
  let bucket = stockInformationRateLimitBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= FUND_RATE_LIMIT_WINDOW_MS) {
    bucket = { startedAt:now, count:0 };
    stockInformationRateLimitBuckets.set(address, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= STOCK_INFORMATION_RATE_LIMIT_MAX) return true;
  res.writeHead(429, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Retry-After':String(Math.max(1, Math.ceil((bucket.startedAt + FUND_RATE_LIMIT_WINDOW_MS - now) / 1000))),
  });
  res.end(JSON.stringify({ error:'资讯财报请求过于频繁，请稍后再试' }));
  return false;
}

async function loadCachedFundValue(cache, key, maxAgeMs, loader, force = false) {
  const now = Date.now();
  const existing = cache.get(key);
  if (!force && existing?.value && now - existing.fetchedAt < maxAgeMs) return existing.value;
  if (existing?.promise) return existing.promise;
  const promise = Promise.resolve().then(loader).then(value => {
    cache.set(key, { value, fetchedAt:Date.now(), promise:null });
    return value;
  }).catch(error => {
    if (existing?.value) {
      const staleValue = { ...existing.value, stale:true, upstreamError:error.message };
      cache.set(key, { value:staleValue, fetchedAt:existing.fetchedAt, promise:null });
      return staleValue;
    }
    cache.delete(key);
    throw error;
  });
  cache.set(key, { value:existing?.value || null, fetchedAt:existing?.fetchedAt || 0, promise });
  return promise;
}

async function requestFundText(url, referer, maxBytes = 5 * 1024 * 1024) {
  const buffer = await requestBuffer(url, {
    ...UPSTREAM_HEADERS,
    Referer:referer,
    Accept:'application/json,text/javascript,text/html;q=0.9,*/*;q=0.8',
  }, { timeoutMs:10000 });
  if (buffer.length > maxBytes) throw new Error('Fund upstream payload is too large');
  return buffer.toString('utf-8').replace(/^\uFEFF/, '');
}

async function loadFundRanking(type, period = 'daily', force = false) {
  const definition = FUND_TYPES[type];
  const rankPeriod = FUND_RANK_PERIODS[period];
  if (!definition || !rankPeriod) throw new Error('Unsupported fund ranking');
  return loadCachedFundValue(fundRankingCache, `${type}:${period}`, FUND_RANKING_CACHE_MS, async () => {
    const query = new URLSearchParams({
      op:'ph', dt:'kf', ft:definition.upstream, rs:'', gs:'0', sc:rankPeriod.upstream, st:'desc',
      sd:fundOneYearAgoDate(), ed:fundDateKey(), qdii:'', tabSubtype:',,,,,', pi:'1', pn:'50', dx:'1',
    });
    const text = await requestFundText(
      `https://fund.eastmoney.com/data/rankhandler.aspx?${query}`,
      'https://fund.eastmoney.com/data/fundranking.html',
      2 * 1024 * 1024
    );
    const parsed = parseFundRanking(text, type);
    return { ...parsed, type, typeLabel:definition.label, period, periodLabel:rankPeriod.label, fetchedAt:Date.now(), source:'天天基金公开行情' };
  }, force);
}

async function loadFundSearch(query) {
  const cacheKey = query.toLocaleLowerCase('zh-CN');
  return loadCachedFundValue(fundSearchCache, cacheKey, FUND_SEARCH_CACHE_MS, async () => {
    const text = await requestFundText(
      `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(query)}`,
      'https://fund.eastmoney.com/',
      512 * 1024
    );
    return { data:parseFundSearch(JSON.parse(text)).slice(0, 12), fetchedAt:Date.now() };
  });
}

async function loadFundDetail(code, force = false) {
  return loadCachedFundValue(fundDetailCache, code, FUND_DETAIL_CACHE_MS, async () => {
    const referer = `https://fund.eastmoney.com/${code}.html`;
    const [scriptResult, searchResult, holdingsResult, pageResult] = await Promise.allSettled([
      requestFundText(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`, referer),
      loadFundSearch(code),
      requestFundText(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=&rt=${Math.random()}`, 'https://fundf10.eastmoney.com/', 2 * 1024 * 1024),
      requestFundText(referer, referer, 4 * 1024 * 1024),
    ]);
    const profile = scriptResult.status === 'fulfilled' ? parseFundScript(scriptResult.value) : null;
    const basicRows = searchResult.status === 'fulfilled' ? searchResult.value.data : [];
    const basic = basicRows.find(item => item.code === code) || basicRows[0] || null;
    if ((!profile || profile.code !== code) && !basic) throw new Error('Fund detail is unavailable');
    const holdings = holdingsResult.status === 'fulfilled' ? parseFundHoldings(holdingsResult.value) : { date:'', data:[], totalRatio:0 };
    const information = pageResult.status === 'fulfilled' ? parseFundNews(pageResult.value) : { news:[], announcements:[] };
    const unavailable = [];
    if (scriptResult.status === 'rejected') unavailable.push('净值与档案');
    if (holdingsResult.status === 'rejected') unavailable.push('持仓');
    if (pageResult.status === 'rejected') unavailable.push('资讯');
    return {
      code, basic, profile, holdings, information, unavailable,
      fetchedAt:Date.now(), source:'天天基金公开行情',
    };
  }, force);
}

async function loadFundQuote(code) {
  if (!fundQuoteCache.has(code) && fundQuoteCache.size >= FUND_QUOTE_CACHE_MAX) {
    fundQuoteCache.delete(fundQuoteCache.keys().next().value);
  }
  return loadCachedFundValue(fundQuoteCache, code, FUND_QUOTE_CACHE_MS, async () => {
    const referer = `https://fund.eastmoney.com/${code}.html`;
    const source = await fundQuoteRequestQueue.run(() => requestFundText(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`,
      referer,
      2 * 1024 * 1024
    ));
    const quote = fundQuoteFromProfile(code, parseFundScript(source));
    return { ...quote, fetchedAt:Date.now(), source:'天天基金公开行情' };
  });
}

async function proxyFundRanking(urlObj, res) {
  const type = urlObj.searchParams.get('type') || 'all';
  const period = urlObj.searchParams.get('period') || 'daily';
  const limit = Math.min(50, Math.max(5, Number(urlObj.searchParams.get('limit')) || 30));
  if (!FUND_TYPES[type] || !FUND_RANK_PERIODS[period]) { sendJson(res, 400, { error:'不支持的基金榜单选项' }); return; }
  try {
    const payload = await loadFundRanking(type, period, urlObj.searchParams.get('refresh') === '1');
    sendJson(res, 200, { ...payload, data:payload.data.slice(0, limit) });
  } catch (error) {
    console.error('Fund ranking error:', error.message);
    sendJson(res, 502, { data:[], error:'基金榜单暂时不可用' });
  }
}

async function proxyFundSearch(urlObj, res) {
  const query = String(urlObj.searchParams.get('q') || '').trim();
  if (!query || query.length > 40) { sendJson(res, 400, { error:'请输入 1—40 个字符的基金名称或代码' }); return; }
  try { sendJson(res, 200, await loadFundSearch(query)); }
  catch (error) {
    console.error('Fund search error:', error.message);
    sendJson(res, 502, { data:[], error:'基金搜索暂时不可用' });
  }
}

async function proxyFundDetail(urlObj, res) {
  const code = String(urlObj.searchParams.get('code') || '');
  if (!/^\d{6}$/.test(code)) { sendJson(res, 400, { error:'基金代码格式不正确' }); return; }
  try { sendJson(res, 200, await loadFundDetail(code, urlObj.searchParams.get('refresh') === '1')); }
  catch (error) {
    console.error(`Fund detail error (${code}):`, error.message);
    sendJson(res, 502, { error:'基金详情暂时不可用' });
  }
}

async function proxyFundQuotes(urlObj, res) {
  const rawCodes = String(urlObj.searchParams.get('codes') || '').split(',').map(code => code.trim()).filter(Boolean);
  const codes = [...new Set(rawCodes)];
  if (!codes.length || codes.length > 30 || codes.some(code => !/^\d{6}$/.test(code))) {
    sendJson(res, 400, { error:'基金代码格式不正确，单次最多查询 30 只' });
    return;
  }
  const settled = await Promise.allSettled(codes.map(loadFundQuote));
  const data = {};
  const unavailable = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') data[`fund${codes[index]}`] = result.value;
    else unavailable.push(codes[index]);
  });
  if (!Object.keys(data).length) {
    sendJson(res, 502, { data, unavailable, error:'基金净值行情暂时不可用' });
    return;
  }
  sendJson(res, 200, { data, unavailable, fetchedAt:Date.now(), partial:unavailable.length > 0 });
}

function oneYearAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const wechatService = createWechatService({ loadIpoCalendar });
const accountService = createAccountService({ referenceDocumentSeed:REFERENCE_DOCUMENT_SEED });
const aiService = createAiService({ accountService });
const chatService = createChatService({
  saveMessage:(userId, message) => accountService.createChatMessage(userId, message),
  listMessages:options => accountService.listChatMessages(options),
});

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  try {
    if (await accountService.handleRoute(req, res, urlObj)) return;
  } catch (error) {
    console.error('Account request error:', error.message);
    if (!res.headersSent) {
      res.writeHead(error.statusCode || 500, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error:'账号服务处理失败' }));
    return;
  }

  try {
    if (await aiService.handleRoute(req, res, urlObj)) return;
  } catch (error) {
    console.error('AI request error:', error.message);
    if (!res.headersSent) {
      res.writeHead(error.statusCode || 500, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error:'问股服务处理失败' }));
    return;
  }

  try {
    if (await wechatService.handleRoute(req, res, urlObj)) return;
  } catch (error) {
    console.error('WeChat request error:', error.message);
    if (!res.headersSent) {
      res.writeHead(error.statusCode || 500, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error:'微信服务处理失败' }));
    return;
  }

  // Chat routes - resolve session user for context
  if (urlObj.pathname.startsWith('/api/chat')) {
    let sessionUser = null;
    try {
      const session = await accountService.sessionFromRequest(req);
      sessionUser = session?.user || null;
    } catch (_) {}
    try {
      if (await chatService.handleRoute(req, res, urlObj, sessionUser)) return;
    } catch (error) {
      console.error('Chat request error:', error.message);
      const status = error.statusCode || 500;
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error:status >= 500 ? '聊天服务处理失败' : error.message }));
      }
      return;
    }
  }

  if (pathname === '/api/quote') {
    const symbols = normalizeQuoteSymbols(urlObj.searchParams.get('symbols'));
    if (!symbols) { res.writeHead(400); res.end('Invalid symbols or too many symbols'); return; }
    await proxyQuote(symbols, res);
    return;
  }

  // Level-5 style snapshot (five bid/ask levels) plus a lightweight
  // intraday signal derived from the current quote and book imbalance.
  if (pathname === '/api/order-book' || pathname === '/api/intraday-signals') {
    if (!allowOrderBookRequest(req, res)) return;
    await proxyOrderBook(urlObj, res);
    return;
  }

  if (pathname === '/api/reference-documents') {
    const documents = await accountService.listPublicReferenceDocuments();
    const fallback = documents && documents.length ? documents : [staticReferenceDocument()];
    sendJson(res, 200, { documents:fallback });
    return;
  }

  if (pathname === '/api/reference-document') {
    const requestedId = urlObj.searchParams.get('id');
    const documents = await accountService.listPublicReferenceDocuments();
    let document = null;
    if (requestedId && requestedId !== 'static') document = await accountService.getPublicReferenceDocument(requestedId);
    if (!document && documents?.length) {
      const selected = requestedId ? documents.find(item => String(item.id) === String(requestedId)) : documents[0];
      if (selected) document = await accountService.getPublicReferenceDocument(selected.id);
    }
    serveReferenceContent(res, document || staticReferenceDocument());
    return;
  }

  if (pathname === '/download/reference-document') {
    const requestedId = urlObj.searchParams.get('id');
    const documents = await accountService.listPublicReferenceDocuments();
    let document = null;
    if (requestedId && requestedId !== 'static') document = await accountService.getPublicReferenceDocument(requestedId);
    if (!document && documents?.length) {
      const selected = requestedId ? documents.find(item => String(item.id) === String(requestedId)) : documents[0];
      if (selected) document = await accountService.getPublicReferenceDocument(selected.id);
    }
    serveReferenceContent(res, document || staticReferenceDocument(), true);
    return;
  }

  if (pathname === '/api/markets') {
    proxyGlobalMarkets(res);
    return;
  }

  if (pathname === '/api/boards') {
    await proxyBoardList(urlObj, res);
    return;
  }

  if (pathname === '/api/board') {
    await proxyBoardDetail(urlObj, res);
    return;
  }

  if (pathname === '/api/stock-boards') {
    await proxyStockBoards(urlObj, res);
    return;
  }

  if (pathname === '/api/capital-flow/rankings') {
    if (!allowCapitalFlowRequest(req, res)) return;
    await proxyCapitalFlowRankings(urlObj, res);
    return;
  }

  if (pathname === '/api/capital-flow/market') {
    if (!allowCapitalFlowRequest(req, res)) return;
    await proxyCapitalFlowMarket(urlObj, res);
    return;
  }

  if (pathname === '/api/market-overview') {
    if (!allowCapitalFlowRequest(req, res)) return;
    await proxyMainlandMarketOverview(urlObj, res);
    return;
  }

  if (pathname === '/api/limit-pools') {
    if (!allowLimitPoolRequest(req, res)) return;
    await proxyLimitPools(urlObj, res);
    return;
  }

  if (pathname === '/api/capital-flow/history') {
    if (!allowCapitalFlowRequest(req, res)) return;
    await proxyCapitalFlowHistory(urlObj, res);
    return;
  }

  if (pathname === '/api/capital-flow/intraday') {
    if (!allowCapitalFlowRequest(req, res)) return;
    await proxyCapitalFlowIntraday(urlObj, res);
    return;
  }

  if (pathname === '/api/derivatives/overview') {
    if (!allowDerivativesRequest(req, res)) return;
    await proxyDerivativesOverview(urlObj, res);
    return;
  }

  if (pathname === '/api/ipos') {
    proxyIpoCalendar(res);
    return;
  }

  if (pathname === '/api/funds') {
    if (!allowFundRequest(req, res)) return;
    await proxyFundRanking(urlObj, res);
    return;
  }

  if (pathname === '/api/fund-search') {
    if (!allowFundRequest(req, res)) return;
    await proxyFundSearch(urlObj, res);
    return;
  }

  if (pathname === '/api/fund-detail') {
    if (!allowFundRequest(req, res)) return;
    await proxyFundDetail(urlObj, res);
    return;
  }

  if (pathname === '/api/fund-quotes') {
    if (!allowFundRequest(req, res)) return;
    await proxyFundQuotes(urlObj, res);
    return;
  }

  if (pathname === '/api/stock-metrics') {
    await proxyStockMetrics(urlObj, res);
    return;
  }

  if (pathname === '/api/stock-information') {
    if (!allowStockInformationRequest(req, res)) return;
    await proxyStockInformation(urlObj, res);
    return;
  }

  if (pathname === '/api/fund-flow-history') {
    await proxyFundFlowHistory(urlObj, res);
    return;
  }

  if (pathname === '/api/kline') {
    const sym = urlObj.searchParams.get('sym') || '';
    if (!/^[a-zA-Z0-9._-]+$/.test(sym)) { res.writeHead(400); res.end('Invalid sym'); return; }
    // Fetch no more than one calendar year. The client keeps the default viewport
    // at the latest 30 sessions and exposes the rest via zoom.
    proxyJson(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,${oneYearAgoDate()},,320,qfq`, res);
    return;
  }

  if (pathname === '/api/minute') {
    const sym = urlObj.searchParams.get('sym') || '';
    if (!/^[a-zA-Z0-9._-]+$/.test(sym)) { res.writeHead(400); res.end('Invalid sym'); return; }
    proxyJson(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${sym}`, res);
    return;
  }

  if (pathname === '/api/minute-kline') {
    const sym = urlObj.searchParams.get('sym') || '';
    const period = urlObj.searchParams.get('period') || 'm5';
    if (!/^[a-zA-Z0-9._-]+$/.test(sym)) { res.writeHead(400); res.end('Invalid sym'); return; }
    if (!/^m(?:1|5|15|30|60)$/.test(period)) { res.writeHead(400); res.end('Invalid period'); return; }
    proxyJson(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${sym},${period},,80`, res);
    return;
  }

  if (pathname === '/api/search') {
    const rawQuery = urlObj.searchParams.get('q') || '';
    const q = normalizeSecuritySearchQuery(rawQuery);
    if (!q || rawQuery.length > 60) { res.writeHead(400); res.end('Invalid q'); return; }
    const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all&c=8`;
    const sreq = https.get(url, { headers: UPSTREAM_HEADERS, timeout: 8000 }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const results = parseTencentSecuritySearch(text);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(results));
      });
    });
    sreq.on('timeout', () => { sreq.destroy(); res.writeHead(504); res.end('[]'); });
    sreq.on('error', () => { res.writeHead(502); res.end('[]'); });
    return;
  }

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Stock monitor running at http://localhost:${PORT}`);
  accountService.start().catch(error => console.error('Account service start failed:', error.message));
  wechatService.start().catch(error => console.error('WeChat service start failed:', error.message));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    chatService.close();
    const results = await Promise.allSettled([accountService.close(), wechatService.close()]);
    if (results[0].status === 'rejected') console.error('Account shutdown error:', results[0].reason.message);
    if (results[1].status === 'rejected') console.error('WeChat shutdown error:', results[1].reason.message);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
