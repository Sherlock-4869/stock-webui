const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createWechatService } = require('./wechat/service');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const gbkDecode = require('./iconv_gbk');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const UPSTREAM_HEADERS = {
  'Referer': 'https://finance.qq.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const GLOBAL_TENCENT_INDEXES = [
  ['sh000001', '000001'], ['sz399001', '399001'], ['sz399006', '399006'],
  ['sh000688', '000688'], ['bj899050', '899050'],
  ['hkHSI', 'HSI'], ['hkHSTECH', 'HSTECH'],
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
const IPO_CACHE_MS = 15 * 60 * 1000;
let ipoCache = null;
let ipoRefreshPromise = null;
const FUNDAMENTAL_CACHE_MS = 6 * 60 * 60 * 1000;
const FUND_FLOW_HISTORY_CACHE_MS = 15 * 1000;
const fundamentalCache = new Map();
const fundFlowHistoryCache = new Map();

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxyQuote(symbols, res) {
  const url = `https://qt.gtimg.cn/q=${symbols}`;
  const req = https.get(url, { headers: UPSTREAM_HEADERS, timeout: 8000 }, (r) => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const text = gbkDecode(Buffer.concat(chunks));
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(text);
    });
  });
  req.on('timeout', () => { req.destroy(); res.writeHead(504); res.end('Upstream timeout'); });
  req.on('error', (e) => { res.writeHead(502); res.end('Upstream error: ' + e.message); });
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

function requestBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (r) => {
      const chunks = [];
      r.on('data', chunk => chunks.push(chunk));
      r.on('end', () => resolve(Buffer.concat(chunks)));
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

function eastmoneySecuCode(symbol) {
  if (!isAShareSymbol(symbol)) return '';
  return `${symbol.slice(2)}.${symbol.startsWith('sh') ? 'SH' : 'SZ'}`;
}

function symbolFromSecuCode(secuCode) {
  const match = String(secuCode || '').match(/^(\d{6})\.(SH|SZ)$/i);
  return match ? `${match[2].toLowerCase()}${match[1]}` : '';
}

async function loadFundamentals(symbols) {
  const aShares = [...new Set(symbols.filter(isAShareSymbol))];
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

async function loadRealtimeFundFlows(symbols) {
  const aShares = [...new Set(symbols.filter(isAShareSymbol))];
  const result = {};
  const queue = [...aShares];
  const workers = Array.from({ length:Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const history = await loadFundFlowHistory(symbol);
        const latest = history[history.length - 1];
        if (!latest) continue;
        result[symbol] = {
          mainNetInflow:latest.mainNet,
          mainNetRatio:latest.mainRatio,
          superLargeNet:latest.superLargeNet,
          largeNet:latest.largeNet,
          updatedAt:latest.date,
        };
      } catch (error) {
        console.error(`Realtime fund flow error (${symbol}):`, error.message);
      }
    }
  });
  await Promise.all(workers);
  return result;
}

async function loadFundFlowHistory(symbol) {
  if (!isAShareSymbol(symbol)) return [];
  const cached = fundFlowHistoryCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < FUND_FLOW_HISTORY_CACHE_MS) return cached.data;
  // 新浪资金分档中 r0 为超大单、r1 为大单；主力净额统一取两者之和。
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
    `MoneyFlow.ssl_qsfx_lscjfb?page=1&num=120&sort=opendate&asc=0&daima=${symbol}`;
  const raw = await requestBuffer(url, {
    ...UPSTREAM_HEADERS,
    Referer:'https://money.finance.sina.com.cn/',
  });
  const rows = JSON.parse(raw.toString('utf-8'));
  const data = (Array.isArray(rows) ? rows : []).map(row => {
    const superLargeNet = numberOrNull(row.r0_net);
    const largeNet = numberOrNull(row.r1_net);
    const mediumNet = numberOrNull(row.r2_net);
    const smallNet = numberOrNull(row.r3_net);
    const mainNet = Number.isFinite(superLargeNet) && Number.isFinite(largeNet)
      ? superLargeNet + largeNet
      : numberOrNull(row.netamount);
    const totalAmount = ['r0','r1','r2','r3']
      .map(key => numberOrNull(row[key]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    return {
      date:row.opendate,
      mainNet,
      smallNet,
      mediumNet,
      largeNet,
      superLargeNet,
      mainRatio:Number.isFinite(mainNet) && totalAmount > 0 ? mainNet / totalAmount * 100 : null,
      smallRatio:Number.isFinite(smallNet) && totalAmount > 0 ? smallNet / totalAmount * 100 : null,
      mediumRatio:Number.isFinite(mediumNet) && totalAmount > 0 ? mediumNet / totalAmount * 100 : null,
      largeRatio:Number.isFinite(largeNet) && totalAmount > 0 ? largeNet / totalAmount * 100 : null,
      superLargeRatio:Number.isFinite(superLargeNet) && totalAmount > 0 ? superLargeNet / totalAmount * 100 : null,
      close:numberOrNull(row.trade),
      pct:numberOrNull(row.changeratio) == null ? null : Number(row.changeratio) * 100,
    };
  }).filter(item => item.date && Number.isFinite(item.mainNet))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!data.length) throw new Error('Fund flow history is empty');
  fundFlowHistoryCache.set(symbol, { fetchedAt:Date.now(), data });
  return data;
}

async function proxyStockMetrics(urlObj, res) {
  const symbols = [...new Set((urlObj.searchParams.get('symbols') || '').split(',')
    .filter(symbol => /^[a-zA-Z0-9._-]+$/.test(symbol)))]
    .slice(0, 50);
  if (!symbols.length) { sendJson(res, 400, { data:{}, error:'Missing symbols' }); return; }
  const includeFundamentals = urlObj.searchParams.get('fundamentals') === '1';
  const includeFlow = urlObj.searchParams.get('flow') === '1';
  const includeFiveDay = urlObj.searchParams.get('fiveDay') === '1';
  const data = Object.fromEntries(symbols.map(symbol => [symbol, {}]));

  const [fundamentals, flow] = await Promise.all([
    includeFundamentals ? loadFundamentals(symbols).catch(() => ({})) : {},
    includeFlow ? loadRealtimeFundFlows(symbols).catch(() => ({})) : {},
  ]);
  symbols.forEach(symbol => Object.assign(data[symbol], fundamentals[symbol], flow[symbol]));

  if (includeFiveDay) {
    const queue = symbols.filter(isAShareSymbol);
    const workers = Array.from({ length:Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const symbol = queue.shift();
        try {
          const history = await loadFundFlowHistory(symbol);
          const lastFive = history.slice(-5).map(item => item.mainNet).filter(Number.isFinite);
          if (lastFive.length) data[symbol].mainFiveDay = lastFive.reduce((sum, value) => sum + value, 0);
        } catch (error) {
          console.error(`Five-day fund flow error (${symbol}):`, error.message);
        }
      }
    });
    await Promise.all(workers);
  }
  sendJson(res, 200, { data, fetchedAt:Date.now() });
}

async function proxyFundFlowHistory(urlObj, res) {
  const symbol = urlObj.searchParams.get('sym') || '';
  if (!isAShareSymbol(symbol)) { sendJson(res, 400, { data:[], error:'仅支持 A 股主力资金数据' }); return; }
  try {
    const data = await loadFundFlowHistory(symbol);
    sendJson(res, 200, { data, fetchedAt:Date.now() });
  } catch (error) {
    console.error(`Fund flow history error (${symbol}):`, error.message);
    sendJson(res, 502, { data:[], error:'主力资金数据暂不可用' });
  }
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
    const columns = [
      'SECURITY_CODE','SECURITY_NAME','APPLY_CODE','APPLY_DATE','LISTING_DATE',
      'BALLOT_NUM_DATE','ISSUE_PRICE','ONLINE_APPLY_UPPER','TOP_APPLY_MARKETCAP',
      'TRADE_MARKET','MARKET_TYPE','ISSUE_NUM','INDUSTRY_NAME'
    ].join(',');
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?' + new URLSearchParams({
      reportName:'RPTA_APP_IPOAPPLY', columns, pageNumber:'1', pageSize:'100',
      sortColumns:'APPLY_DATE', sortTypes:'-1', source:'WEB', client:'WEB',
    });
    const raw = await requestBuffer(url, { ...UPSTREAM_HEADERS, Referer:'https://data.eastmoney.com/' });
    const payload = JSON.parse(raw.toString('utf-8'));
    const rows = payload?.result?.data || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - 14);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 60);
    const data = rows.map(row => ({
      code:row.SECURITY_CODE, name:row.SECURITY_NAME, applyCode:row.APPLY_CODE,
      applyDate:row.APPLY_DATE, listingDate:row.LISTING_DATE, ballotDate:row.BALLOT_NUM_DATE,
      price:row.ISSUE_PRICE, upperLimit:row.ONLINE_APPLY_UPPER,
      requiredMarketCap:row.TOP_APPLY_MARKETCAP, market:row.TRADE_MARKET,
      board:row.MARKET_TYPE, issueShares:row.ISSUE_NUM, industry:row.INDUSTRY_NAME,
    })).filter(item => {
      const date = new Date(item.applyDate);
      return Number.isFinite(date.getTime()) && date >= minDate && date <= maxDate;
    }).sort((a,b) => new Date(b.applyDate) - new Date(a.applyDate));
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

function oneYearAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const wechatService = createWechatService({ loadIpoCalendar });

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

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

  if (pathname === '/api/quote') {
    const symbols = urlObj.searchParams.get('symbols') || '';
    if (!symbols) { res.writeHead(400); res.end('Missing symbols'); return; }
    const safe = symbols.split(',').filter(s => /^[a-zA-Z0-9._-]+$/.test(s)).join(',');
    if (!safe) { res.writeHead(400); res.end('No valid symbols'); return; }
    proxyQuote(safe, res);
    return;
  }

  if (pathname === '/api/markets') {
    proxyGlobalMarkets(res);
    return;
  }

  if (pathname === '/api/ipos') {
    proxyIpoCalendar(res);
    return;
  }

  if (pathname === '/api/stock-metrics') {
    await proxyStockMetrics(urlObj, res);
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
    const q = urlObj.searchParams.get('q') || '';
    if (!q) { res.writeHead(400); res.end('Missing q'); return; }
    const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all&c=8`;
    const sreq = https.get(url, { headers: UPSTREAM_HEADERS, timeout: 8000 }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const m = text.match(/v_hint="([^"]*)"/);
        const results = [];
        if (m && m[1]) {
          for (const item of m[1].split('^')) {
            const parts = item.split('~');
            if (parts.length < 3) continue;
            const [market, code, rawName, , type] = parts;
            if (type && !/^GP(?:-|$)/.test(type)) continue;
            let name;
            try { name = JSON.parse('"' + rawName.replace(/"/g, '\\"') + '"'); }
            catch(e) { name = rawName; }
            const mkt = market.toLowerCase();
            if (!['sh', 'sz', 'hk', 'us'].includes(mkt)) continue;
            const normalizedCode = mkt === 'us'
              ? code.replace(/\.[A-Z]+$/i, '').toUpperCase()
              : code.toUpperCase();
            const sym = `${mkt}${normalizedCode}`;
            results.push({ sym, name, market: market.toUpperCase(), code: normalizedCode });
          }
        }
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
  wechatService.start().catch(error => console.error('WeChat service start failed:', error.message));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    try { await wechatService.close(); }
    catch (error) { console.error('WeChat shutdown error:', error.message); }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
