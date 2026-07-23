const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

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
  ['b_KOSPI', 'KOSPI'], ['int_nikkei', 'N225'],
  ['int_dax30', 'GDAXI'], ['int_ftse', 'FTSE'],
];
const GLOBAL_MARKET_CACHE_MS = 4500;
const globalMarketCache = new Map();
let globalMarketSnapshot = null;
let globalMarketRefreshPromise = null;

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
    const [, priceRaw, changeRaw, pctRaw] = match[1].split(',');
    const price = Number(priceRaw), change = Number(changeRaw);
    return {
      code, price, change, pct: Number(pctRaw), prevClose: price - change,
      open: null, high: null, low: null, updated: '',
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

function oneYearAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

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
});
