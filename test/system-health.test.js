'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  classifyUpstreamUrl,
  createAdminConsoleHandlers,
  createUpstreamMonitor,
  maskOpenid,
  sanitizeErrorText,
} = require('../system-health');
const { sanitizeWorkbenchState, tokenHash } = require('../account/security');
const { AccountService } = require('../account/service');
const { WeChatService } = require('../wechat/service');

test('classifies upstream hosts, tracks latency/degradation, and redacts sensitive URLs in errors', () => {
  assert.equal(classifyUpstreamUrl('https://qt.gtimg.cn/q=sh600519'), 'tencent_quote');
  assert.equal(classifyUpstreamUrl('https://push2.eastmoney.com/api/qt/clist/get'), 'eastmoney_push');
  assert.equal(classifyUpstreamUrl('https://push2delay.eastmoney.com/api/qt/clist/get'), 'eastmoney_delay');
  assert.equal(classifyUpstreamUrl('https://datacenter-web.eastmoney.com/api/data/v1/get'), 'eastmoney_datacenter');
  assert.equal(classifyUpstreamUrl('https://newsapi.eastmoney.com/kuaixun/v1/getlist_102'), 'eastmoney_news');
  assert.equal(classifyUpstreamUrl('https://hq.sinajs.cn/list=hf_ES'), 'sina_finance');

  assert.equal(
    sanitizeErrorText(new Error('Failed https://example.com/api?token=secret123&key=abc')),
    'Failed [url]'
  );

  let clock = 1000;
  const monitor = createUpstreamMonitor({ now: () => clock });
  monitor.recordSuccess('https://qt.gtimg.cn/q=sh000001', 42);
  clock += 5000;
  monitor.recordFailure('https://push2.eastmoney.com/api/qt/clist/get', 9000, new Error('Upstream timeout'));

  const snap = monitor.snapshot();
  assert.equal(snap.uptimeSeconds, 5);
  const tencent = snap.providers.find(p => p.id === 'tencent_quote');
  const emPush = snap.providers.find(p => p.id === 'eastmoney_push');
  assert.equal(tencent.status, 'healthy');
  assert.equal(tencent.avgLatencyMs, 42);
  assert.equal(tencent.successRate, 100);
  assert.equal(emPush.status, 'degraded');
  assert.equal(emPush.errorCount, 1);

  monitor.recordFailure('https://push2.eastmoney.com/api/qt/clist/get', 8000, new Error('socket hang up'));
  monitor.recordFailure('https://push2.eastmoney.com/api/qt/clist/get', 8000, new Error('socket hang up'));
  assert.equal(monitor.snapshot().providers.find(p => p.id === 'eastmoney_push').status, 'down');
});

test('masks WeChat OpenIDs without exposing raw subscriber identifiers', () => {
  assert.equal(maskOpenid('o6_bmjrPTlm6_2sgVt7hMZOPfL2M'), 'o6_b***fL2M');
  assert.equal(maskOpenid('shortid'), 'sh***id');
  assert.equal(maskOpenid(''), '--');
});

test('preserves optional bounded trade journal metadata in workbench state while keeping legacy shape clean', () => {
  const state = sanitizeWorkbenchState({
    positions: [],
    trades: [
      { at: 100, symbol: 'sh600519', name: '贵州茅台', side: 'buy', quantity: 100, price: 1500, note: '低估值左侧配置', tag: '低估配置', stopLoss: 1380, takeProfit: 1800 },
      { at: 200, symbol: 'sz000001', name: '平安银行', side: 'sell', quantity: 200, price: 11.5 },
    ],
    alerts: [],
    events: [],
  });

  assert.equal(state.trades[0].note, '低估值左侧配置');
  assert.equal(state.trades[0].tag, '低估配置');
  assert.equal(state.trades[0].stopLoss, 1380);
  assert.equal(state.trades[0].takeProfit, 1800);
  assert.equal('note' in state.trades[1], false);
  assert.equal('stopLoss' in state.trades[1], false);
});

test('admin WeChat and system health routes enforce session admin auth, CSRF origin checks, and OpenID masking', async t => {
  const accountService = new AccountService({ env: { STOCK_ACCOUNT_ENABLED: 'true', STOCK_ACCOUNT_DRIVER: 'memory' } });
  await accountService.start();
  t.after(() => accountService.close());

  const adminUser = await accountService.database.createPasswordUser({ username: 'ops-admin', passwordHash: 'hash', displayName: '运维管理员' });
  const regularUser = await accountService.database.createPasswordUser({ username: 'normal-member', passwordHash: 'hash', displayName: '普通成员' });
  accountService.database.users.get(adminUser.id).is_admin = 1;

  const adminToken = 'admin-session-token-fixed-for-test-0001';
  const userToken = 'regular-session-token-fixed-for-test-02';
  await accountService.database.createSession({ userId: adminUser.id, tokenHash: tokenHash(adminToken), expiresAt: new Date(Date.now() + 60_000) });
  await accountService.database.createSession({ userId: regularUser.id, tokenHash: tokenHash(userToken), expiresAt: new Date(Date.now() + 60_000) });

  const rawSubscriberOpenid = 'o6_bmjrPTlm6_2sgVt7hMZOPfL2M';
  const mockWechatDb = {
    async subscriberStats() { return { total: 5, subscribed: 4, enabled: 3 }; },
    async listRecentJobs() {
      return [{ id: 42, job_key: 'weekly-ipo:2026-11-23', week_start: '2026-11-23', week_end: '2026-11-29', ipo_count: 2, status: 'completed', recipient_count: 3, success_count: 3, failure_count: 0 }];
    },
    async getJobById(id) {
      return String(id) === '42'
        ? { id: 42, job_key: 'weekly-ipo:2026-11-23', week_start: '2026-11-23', week_end: '2026-11-29', ipo_count: 2, message_content: '本周新股预览', status: 'completed', recipient_count: 1, success_count: 1, failure_count: 0 }
        : null;
    },
    async listJobDeliveries() {
      return [{ id: 9, openid: rawSubscriberOpenid, status: 'sent', attempt_count: 1, wechat_errcode: 0, wechat_errmsg: 'ok' }];
    },
  };
  const wechatService = new WeChatService({
    env: {
      WECHAT_ENABLED: 'true',
      WECHAT_IPO_PAGE_URL: 'https://stock.example.com',
      WECHAT_TIMEZONE: 'Asia/Shanghai',
    },
    loadIpoCalendar: async () => ({ data: [] }),
  });
  wechatService.database = mockWechatDb;
  wechatService.ready = true;

  let clearedTargets = [];
  const monitor = createUpstreamMonitor({ now: () => 10_000 });
  const handlers = createAdminConsoleHandlers({
    accountService,
    wechatService,
    aiService: {
      getAdminRuntimeStatus: async () => ({ enabled: true, hasInternalToken: true, hasEncryptionKey: true, agentUrl: 'http://127.0.0.1:8788' }),
      probeAgentHealth: async () => ({ ok: true, status: 'healthy', latencyMs: 8, message: '连通正常' }),
    },
    chatService: { onlineUsers: () => [{ id: '1', connections: 2 }] },
    upstreamMonitor: monitor,
    buildSystemCacheSummary: () => [{ key: 'quotes', label: '实时行情', entries: 4 }],
    clearSystemCaches: target => {
      if (target !== 'all' && target !== 'quotes') return null;
      clearedTargets.push(target);
      return [target];
    },
    requestBuffer: async () => Buffer.from('ok'),
    probeSpecs: { tencent: { url: 'https://qt.gtimg.cn/q=sh000001', headers: {} } },
  });

  async function dispatch(pathname, { method = 'GET', cookie = '', origin = 'http://stock.test', body } = {}) {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
    req.method = method;
    req.url = pathname;
    req.headers = {
      host: 'stock.test',
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
    };
    req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
    const res = {
      status: 200,
      headers: {},
      body: '',
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(chunk = '') { this.body = String(chunk); this.writableEnded = true; },
    };
    const urlObj = new URL(pathname, 'http://stock.test');
    try {
      const delegatedFromAccount = await accountService.handleRoute(req, res, urlObj);
      assert.equal(delegatedFromAccount, false);
      const handled = (await handlers.handleAdminWechatRoute(req, res, urlObj))
        || (await handlers.handleAdminSystemRoute(req, res, urlObj));
      assert.equal(handled, true);
    } catch (error) {
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return { status: res.status, body: res.body, payload: res.body ? JSON.parse(res.body) : {} };
  }

  // 1. Visitor (unauthenticated) -> 401
  assert.equal((await dispatch('/api/admin/wechat/overview')).status, 401);
  assert.equal((await dispatch('/api/admin/system/health')).status, 401);

  // 2. Authenticated non-admin -> 403
  const userCookie = `stock_session=${userToken}`;
  assert.equal((await dispatch('/api/admin/wechat/overview', { cookie: userCookie })).status, 403);
  assert.equal((await dispatch('/api/admin/wechat/push', { method: 'POST', cookie: userCookie, body: { kind: 'weekly', dryRun: true } })).status, 403);
  assert.equal((await dispatch('/api/admin/system/health', { cookie: userCookie })).status, 403);
  assert.equal((await dispatch('/api/admin/system/cache-clear', { method: 'POST', cookie: userCookie, body: { target: 'all' } })).status, 403);

  // 3. Authenticated admin with cross-origin POST -> 403 CSRF blocked
  const adminCookie = `stock_session=${adminToken}`;
  assert.equal((await dispatch('/api/admin/system/cache-clear', {
    method: 'POST',
    cookie: adminCookie,
    origin: 'https://evil.example',
    body: { target: 'all' },
  })).status, 403);
  assert.equal(clearedTargets.length, 0);

  // 4. Authenticated admin same-origin -> 200 & masked OpenIDs
  const wechatOverview = await dispatch('/api/admin/wechat/overview', { cookie: adminCookie });
  assert.equal(wechatOverview.status, 200);
  assert.equal(wechatOverview.payload.subscribers.enabled, 3);
  assert.equal(wechatOverview.payload.recentJobs.length, 1);

  const jobDetail = await dispatch('/api/admin/wechat/jobs?id=42', { cookie: adminCookie });
  assert.equal(jobDetail.status, 200);
  assert.equal(jobDetail.payload.deliveries[0].maskedOpenid, 'o6_b***fL2M');
  assert.equal(jobDetail.body.includes(rawSubscriberOpenid), false);

  const dryRunPush = await dispatch('/api/admin/wechat/push', {
    method: 'POST',
    cookie: adminCookie,
    body: { kind: 'weekly', dryRun: true },
  });
  assert.equal(dryRunPush.status, 200);
  assert.equal(dryRunPush.payload.dryRun, true);

  const sysHealth = await dispatch('/api/admin/system/health', { cookie: adminCookie });
  assert.equal(sysHealth.status, 200);
  assert.equal(sysHealth.payload.services.chat.totalConnections, 2);

  const clearRes = await dispatch('/api/admin/system/cache-clear', {
    method: 'POST',
    cookie: adminCookie,
    body: { target: 'quotes' },
  });
  assert.equal(clearRes.status, 200);
  assert.deepEqual(clearedTargets, ['quotes']);
});
