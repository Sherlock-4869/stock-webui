'use strict';

const { assertSameOrigin, readJson } = require('./account/service');

const UPSTREAM_PROVIDERS = Object.freeze([
  {
    id: 'tencent_quote',
    name: '腾讯财经行情与K线',
    role: '实时报价、五档盘口、分时与前复权日K',
    match: host => /(^|\.)(gtimg\.cn|qq\.com)$/i.test(host),
  },
  {
    id: 'eastmoney_push',
    name: '东方财富实时与资金主源',
    role: '板块行情、主力资金流、涨跌停与炸板股池',
    match: host => /^(push2|push2his|push2ex)\.eastmoney\.com$/i.test(host),
  },
  {
    id: 'eastmoney_delay',
    name: '东方财富延迟降级镜像',
    role: '主源限流断连时的 15 分钟延迟兜底镜像',
    match: host => /^push2delay\.eastmoney\.com$/i.test(host),
  },
  {
    id: 'eastmoney_datacenter',
    name: '东方财富数据中心与F10',
    role: '财务报表、龙虎榜、两融、解禁、打新与财报日历',
    match: host => /^(datacenter|datacenter-web|emweb\.securities|np-anotice-stock)\.eastmoney\.com$/i.test(host),
  },
  {
    id: 'eastmoney_news',
    name: '东方财富 7×24 快讯服务',
    role: '7×24 全球电报、期货快讯与美股夜盘资讯',
    match: host => /^(newsapi|qhweb)\.eastmoney\.com$/i.test(host),
  },
  {
    id: 'eastmoney_fund',
    name: '天天基金净值与排行',
    role: '公募基金净值估值、重仓穿透与业绩榜单',
    match: host => /(^|\.)(1234567\.com\.cn|fund\.eastmoney\.com|fundsuggest\.eastmoney\.com)$/i.test(host),
  },
  {
    id: 'sina_finance',
    name: '新浪财经行情与备用源',
    role: '全球指数、股指期货、贵金属、个股资讯及板块降级',
    match: host => /(^|\.)(sinajs\.cn|sina\.com\.cn)$/i.test(host),
  },
]);

function classifyUpstreamUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const host = parsed.hostname.toLowerCase();
    const matched = UPSTREAM_PROVIDERS.find(provider => provider.match(host));
    return matched ? matched.id : null;
  } catch (_) {
    return null;
  }
}

function sanitizeErrorText(error) {
  const message = String(error?.message || error || 'upstream error')
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/\b(?:token|key|secret|password)=[^&\s]+/gi, '[redacted]')
    .trim();
  return message.slice(0, 160);
}

function maskOpenid(openid) {
  const raw = String(openid || '').trim();
  if (!raw) return '--';
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function createUpstreamMonitor({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const stats = new Map(
    UPSTREAM_PROVIDERS.map(provider => [provider.id, {
      id: provider.id,
      name: provider.name,
      role: provider.role,
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      avgLatencyMs: null,
      lastLatencyMs: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
    }])
  );

  function recordSuccess(url, latencyMs) {
    const id = classifyUpstreamUrl(url);
    if (!id) return;
    const entry = stats.get(id);
    const ms = Math.max(0, Math.round(Number(latencyMs) || 0));
    entry.totalRequests += 1;
    entry.successCount += 1;
    entry.consecutiveErrors = 0;
    entry.lastLatencyMs = ms;
    entry.avgLatencyMs = entry.avgLatencyMs == null ? ms : Math.round(entry.avgLatencyMs * 0.75 + ms * 0.25);
    entry.lastSuccessAt = now();
  }

  function recordFailure(url, latencyMs, error) {
    const id = classifyUpstreamUrl(url);
    if (!id) return;
    const entry = stats.get(id);
    const ms = Math.max(0, Math.round(Number(latencyMs) || 0));
    entry.totalRequests += 1;
    entry.errorCount += 1;
    entry.consecutiveErrors += 1;
    entry.lastLatencyMs = ms;
    entry.lastErrorAt = now();
    entry.lastError = sanitizeErrorText(error);
  }

  function providerStatus(entry) {
    if (entry.totalRequests === 0) return 'idle';
    if (entry.consecutiveErrors >= 3) return 'down';
    if (entry.consecutiveErrors >= 1) return 'degraded';
    return 'healthy';
  }

  function snapshot() {
    const providers = UPSTREAM_PROVIDERS.map(def => {
      const entry = stats.get(def.id);
      const successRate = entry.totalRequests > 0
        ? Math.round((entry.successCount / entry.totalRequests) * 1000) / 10
        : null;
      return {
        ...entry,
        status: providerStatus(entry),
        successRate,
      };
    });
    return {
      startedAt,
      uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      providers,
    };
  }

  return {
    recordSuccess,
    recordFailure,
    snapshot,
  };
}

function defaultSendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function createAdminConsoleHandlers({
  accountService,
  wechatService,
  aiService,
  chatService,
  upstreamMonitor,
  buildSystemCacheSummary,
  clearSystemCaches,
  probeSpecs = {},
  requestBuffer,
  shanghaiDateKey = () => new Date().toISOString().slice(0, 10),
  sendJson = defaultSendJson,
}) {
  async function handleAdminWechatRoute(req, res, urlObj) {
    const pathname = urlObj.pathname;
    if (!pathname.startsWith('/api/admin/wechat/')) return false;
    if (!accountService.config.enabled || !accountService.ready) {
      sendJson(res, 503, { error: '账号鉴权服务未启用，无法访问管理后台' });
      return true;
    }
    await accountService.requireAdmin(req);

    if (pathname === '/api/admin/wechat/overview' && req.method === 'GET') {
      sendJson(res, 200, await wechatService.getAdminOverview());
      return true;
    }

    if (pathname === '/api/admin/wechat/jobs' && req.method === 'GET') {
      const jobId = String(urlObj.searchParams.get('id') || '').trim();
      if (!/^\d{1,20}$/.test(jobId)) {
        sendJson(res, 400, { error: '任务编号格式无效' });
        return true;
      }
      sendJson(res, 200, await wechatService.getAdminJobDetail(jobId, maskOpenid));
      return true;
    }

    if (req.method === 'POST') {
      assertSameOrigin(req);
      const body = await readJson(req, 16 * 1024);

      if (pathname === '/api/admin/wechat/push') {
        if (!wechatService.ready) {
          sendJson(res, 503, { error: wechatService.initializationError || '微信公众号服务未启用或尚未就绪' });
          return true;
        }
        const kind = body?.kind === 'daily' ? 'daily' : body?.kind === 'weekly' ? 'weekly' : '';
        if (!kind) {
          sendJson(res, 400, { error: '推送类型仅支持 weekly 或 daily' });
          return true;
        }
        const dryRun = body?.dryRun === true;
        const retryFailed = body?.retryFailed === true;
        const result = kind === 'daily'
          ? await wechatService.runDailyPush({ dryRun, retryFailed, trigger: 'admin_ui' })
          : await wechatService.runWeeklyPush({ dryRun, retryFailed, trigger: 'admin_ui' });
        sendJson(res, 200, { kind, ...result });
        return true;
      }

      if (pathname === '/api/admin/wechat/menu/sync') {
        const result = await wechatService.syncMenuForAdmin();
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === '/api/admin/wechat/subscribers/sync') {
        const result = await wechatService.syncSubscribersForAdmin();
        sendJson(res, 200, result);
        return true;
      }
    }

    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  async function handleAdminSystemRoute(req, res, urlObj) {
    const pathname = urlObj.pathname;
    if (!pathname.startsWith('/api/admin/system/')) return false;
    if (!accountService.config.enabled || !accountService.ready) {
      sendJson(res, 503, { error: '账号鉴权服务未启用，无法访问系统监控' });
      return true;
    }
    await accountService.requireAdmin(req);

    if (pathname === '/api/admin/system/health' && req.method === 'GET') {
      const mem = process.memoryUsage();
      const onlineUsers = chatService ? chatService.onlineUsers() : [];
      const totalSseConnections = onlineUsers.reduce((sum, u) => sum + (Number(u.connections) || 0), 0);
      const aiRuntime = aiService ? await aiService.getAdminRuntimeStatus() : { enabled: false };
      sendJson(res, 200, {
        runtime: {
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          shanghaiDate: shanghaiDateKey(),
        },
        services: {
          account: { enabled: Boolean(accountService.config.enabled), ready: Boolean(accountService.ready), driver: accountService.config.driver },
          wechat: { enabled: Boolean(wechatService?.config?.enabled), ready: Boolean(wechatService?.ready), error: wechatService?.initializationError || null },
          ai: aiRuntime,
          chat: { onlineUsers: onlineUsers.length, totalConnections: totalSseConnections },
        },
        upstream: upstreamMonitor.snapshot(),
        caches: buildSystemCacheSummary(),
        fetchedAt: Date.now(),
      });
      return true;
    }

    if (req.method === 'POST') {
      assertSameOrigin(req);
      const body = await readJson(req, 16 * 1024);

      if (pathname === '/api/admin/system/cache-clear') {
        const target = String(body?.target || 'all').trim();
        const cleared = clearSystemCaches(target);
        if (!cleared) {
          sendJson(res, 400, { error: '不支持的缓存清理目标' });
          return true;
        }
        sendJson(res, 200, { cleared, caches: buildSystemCacheSummary(), clearedAt: Date.now() });
        return true;
      }

      if (pathname === '/api/admin/system/probe') {
        const target = String(body?.target || '').trim();
        const started = Date.now();
        if (target === 'ai_agent') {
          sendJson(res, 200, { target, ...(await aiService.probeAgentHealth()) });
          return true;
        }
        const spec = probeSpecs[target];
        if (!spec || typeof requestBuffer !== 'function') {
          sendJson(res, 400, { error: '不支持的探测目标' });
          return true;
        }
        try {
          await requestBuffer(spec.url, spec.headers, { timeoutMs: 5000, maxBytes: 128 * 1024 });
          sendJson(res, 200, { target, ok: true, status: 'healthy', latencyMs: Date.now() - started, message: '主动探测响应正常' });
        } catch (error) {
          sendJson(res, 200, { target, ok: false, status: 'down', latencyMs: Date.now() - started, message: sanitizeErrorText(error) || '探测失败' });
        }
        return true;
      }
    }

    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  return {
    handleAdminWechatRoute,
    handleAdminSystemRoute,
  };
}

module.exports = {
  UPSTREAM_PROVIDERS,
  classifyUpstreamUrl,
  createAdminConsoleHandlers,
  createUpstreamMonitor,
  maskOpenid,
  sanitizeErrorText,
};
