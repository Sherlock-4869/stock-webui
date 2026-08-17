'use strict';

const crypto = require('crypto');
const { loadWechatConfig } = require('./config');
const { WeChatClient } = require('./client');
const { WeChatDatabase } = require('./database');
const { parseWechatXml, textReplyXml } = require('./xml');
const {
  zonedParts,
  weekRange,
  selectWeekIpos,
  selectDailyIpos,
  buildWeeklyMessage,
  buildDailyMessage,
} = require('./weekly-ipo');

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function signatureFor(token, timestamp, nonce) {
  return crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function buildDefaultMenu(pageUrl) {
  return {
    button: [
      {
        name: '打新服务',
        sub_button: [
          { type: 'click', name: '本周打新', key: 'IPO_WEEKLY' },
          { type: 'click', name: '开启提醒', key: 'IPO_ENABLE' },
          { type: 'click', name: '关闭提醒', key: 'IPO_DISABLE' },
        ],
      },
      { type: 'view', name: '打新日历', url: pageUrl },
    ],
  };
}

class WeChatService {
  constructor({ loadIpoCalendar, env = process.env }) {
    this.config = loadWechatConfig(env);
    this.loadIpoCalendar = loadIpoCalendar;
    this.client = new WeChatClient(this.config);
    this.database = new WeChatDatabase(this.config.database);
    this.ready = false;
    this.initializationError = null;
    this.timer = null;
    this.running = false;
    this.lastScheduledWeek = null;
    this.lastScheduledDay = null;
    this.nextWeeklyScheduleRetryAt = 0;
    this.nextDailyScheduleRetryAt = 0;
  }

  async start() {
    if (!this.config.enabled) {
      console.log('WeChat IPO notification is disabled');
      return;
    }
    if (this.config.missing.length) {
      this.initializationError = `Missing configuration: ${this.config.missing.join(', ')}`;
      console.error(`WeChat initialization skipped: ${this.initializationError}`);
      return;
    }
    try {
      await this.database.initialize();
      this.ready = true;
      const dailySchedule = this.config.dailyIpoEnabled
        ? `; daily IPO ${String(this.config.dailyIpoHour).padStart(2, '0')}:${String(this.config.dailyIpoMinute).padStart(2, '0')}`
        : '; daily IPO disabled';
      console.log(`WeChat IPO notification ready (${this.config.timezone}, weekly weekday=${this.config.scheduleWeekday} ${String(this.config.scheduleHour).padStart(2, '0')}:${String(this.config.scheduleMinute).padStart(2, '0')}${dailySchedule})`);
      this.timer = setInterval(() => this.checkSchedule().catch(error => {
        console.error('WeChat schedule check failed:', error.message);
      }), 30 * 1000);
      this.timer.unref();
      setTimeout(() => this.checkSchedule().catch(error => {
        console.error('Initial WeChat schedule check failed:', error.message);
      }), 2000).unref();
    } catch (error) {
      this.initializationError = error.message;
      console.error('WeChat initialization failed:', error.message);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ready) await this.database.close();
    this.ready = false;
  }

  verifyCallback(urlObject) {
    const timestamp = urlObject.searchParams.get('timestamp') || '';
    const nonce = urlObject.searchParams.get('nonce') || '';
    const signature = urlObject.searchParams.get('signature') || '';
    return Boolean(timestamp && nonce && signature && safeEqual(signatureFor(this.config.callbackToken, timestamp, nonce), signature));
  }

  authorized(req) {
    if (!this.config.adminKey) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const headerKey = req.headers['x-admin-key'] || '';
    return safeEqual(bearer || headerKey, this.config.adminKey);
  }

  async handleRoute(req, res, urlObject) {
    const pathname = urlObject.pathname;
    if (pathname === '/wechat/callback') {
      await this.handleCallback(req, res, urlObject);
      return true;
    }
    if (!pathname.startsWith('/internal/wechat/')) return false;
    if (!this.authorized(req)) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return true;
    }
    if (pathname === '/internal/wechat/status' && req.method === 'GET') {
      const stats = this.ready ? await this.database.subscriberStats() : null;
      jsonResponse(res, 200, {
        enabled: this.config.enabled,
        ready: this.ready,
        error: this.initializationError,
        schedule: {
          timezone: this.config.timezone,
          weekday: this.config.scheduleWeekday,
          hour: this.config.scheduleHour,
          minute: this.config.scheduleMinute,
          catchup: this.config.scheduleCatchup,
          dailyIpo: {
            enabled: this.config.dailyIpoEnabled,
            hour: this.config.dailyIpoHour,
            minute: this.config.dailyIpoMinute,
          },
        },
        subscribers: stats,
      });
      return true;
    }
    if (!this.ready) {
      jsonResponse(res, 503, { error: this.initializationError || 'WeChat service is not ready' });
      return true;
    }
    if (pathname === '/internal/wechat/ipo/run' && req.method === 'POST') {
      const dryRun = urlObject.searchParams.get('dry_run') === '1';
      const retryFailed = urlObject.searchParams.get('retry_failed') === '1';
      const result = await this.runWeeklyPush({ dryRun, retryFailed, trigger: 'manual' });
      jsonResponse(res, 200, result);
      return true;
    }
    if (pathname === '/internal/wechat/ipo/daily/run' && req.method === 'POST') {
      const dryRun = urlObject.searchParams.get('dry_run') === '1';
      const retryFailed = urlObject.searchParams.get('retry_failed') === '1';
      const result = await this.runDailyPush({ dryRun, retryFailed, trigger: 'manual' });
      jsonResponse(res, 200, result);
      return true;
    }
    if (pathname === '/internal/wechat/menu/sync' && req.method === 'POST') {
      const menu = buildDefaultMenu(this.config.pageUrl);
      try {
        const wechat = await this.client.createMenu(menu);
        jsonResponse(res, 200, { created: true, menu, wechat });
      } catch (error) {
        console.error('WeChat menu synchronization failed:', error.message);
        jsonResponse(res, 502, {
          created: false,
          errcode: Number.isFinite(Number(error.errcode)) ? Number(error.errcode) : -1,
          error: error.message,
        });
      }
      return true;
    }
    if (pathname === '/internal/wechat/subscribers/sync' && req.method === 'POST') {
      const openids = await this.client.listFollowers();
      const count = await this.database.syncFollowers(openids, this.config.autoEnable);
      jsonResponse(res, 200, { synchronized: count });
      return true;
    }
    jsonResponse(res, 404, { error: 'Not Found' });
    return true;
  }

  async handleCallback(req, res, urlObject) {
    if (!this.config.enabled || !this.config.callbackToken) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('WeChat integration is disabled');
      return;
    }
    if (!this.verifyCallback(urlObject)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid signature');
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(urlObject.searchParams.get('echostr') || '');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }
    if (!this.ready) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('WeChat service is not ready');
      return;
    }
    if (urlObject.searchParams.get('encrypt_type') === 'aes') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('AES callback mode is not configured');
      return;
    }
    const body = await readBody(req);
    const message = parseWechatXml(body);
    const reply = await this.processMessage(message);
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(reply || 'success');
  }

  async processMessage(message) {
    const openid = message.FromUserName;
    if (!openid) return 'success';
    const messageType = String(message.MsgType || '').toLowerCase();
    const event = String(message.Event || '').toLowerCase();
    if (messageType === 'event' && event === 'subscribe') {
      await this.database.recordSubscribe(openid, this.config.autoEnable);
      return textReplyXml(message, this.config.autoEnable
        ? '关注成功，已开启打新提醒。回复“取消打新”可关闭，回复“本周打新”可立即查询。'
        : '关注成功。回复“打新”开启提醒，回复“本周打新”可立即查询。');
    }
    if (messageType === 'event' && event === 'unsubscribe') {
      await this.database.recordUnsubscribe(openid);
      return 'success';
    }
    if (messageType === 'event' && event === 'click') {
      await this.database.recordInteraction(openid);
      const eventKey = String(message.EventKey || '').toUpperCase();
      if (eventKey === 'IPO_ENABLE') {
        await this.database.setNotification(openid, true);
        return textReplyXml(message, '打新提醒已开启。');
      }
      if (eventKey === 'IPO_DISABLE') {
        await this.database.setNotification(openid, false);
        return textReplyXml(message, '打新提醒已关闭。');
      }
      if (eventKey === 'IPO_WEEKLY') return textReplyXml(message, await this.currentWeeklyMessage());
      return 'success';
    }
    if (messageType === 'text') {
      await this.database.recordInteraction(openid);
      const content = String(message.Content || '').trim();
      if (['取消打新', '关闭打新'].includes(content)) {
        await this.database.setNotification(openid, false);
        return textReplyXml(message, '打新提醒已关闭。回复“打新”可以重新开启。');
      }
      if (['打新', '开启打新'].includes(content)) {
        await this.database.setNotification(openid, true);
        return textReplyXml(message, '打新提醒已开启。系统会推送每周汇总，并在当日有可申购新股或新债时追加提醒。');
      }
      if (['本周打新', '本周新股', '本周新债'].includes(content)) return textReplyXml(message, await this.currentWeeklyMessage());
      return textReplyXml(message, '回复“本周打新”查询本周新股和新债；回复“打新”开启提醒；回复“取消打新”关闭提醒。');
    }
    return 'success';
  }

  async currentWeeklyMessage(now = new Date()) {
    const range = weekRange(now, this.config.timezone);
    const payload = await this.loadIpoCalendar();
    const items = selectWeekIpos(payload.data, range);
    return buildWeeklyMessage(items, range, this.config.pageUrl);
  }

  async checkSchedule(now = new Date()) {
    if (!this.ready || this.running) return;
    const local = zonedParts(now, this.config.timezone);
    const currentMinutes = local.hour * 60 + local.minute;
    const dueAt = (hour, minute) => this.config.scheduleCatchup
      ? currentMinutes >= hour * 60 + minute
      : currentMinutes === hour * 60 + minute;
    const errors = [];

    const range = weekRange(now, this.config.timezone);
    const weeklyDue = local.weekday === this.config.scheduleWeekday
      && dueAt(this.config.scheduleHour, this.config.scheduleMinute)
      && this.lastScheduledWeek !== range.start
      && Date.now() >= this.nextWeeklyScheduleRetryAt;
    if (weeklyDue) {
      try {
        await this.runWeeklyPush({ trigger: 'schedule', now });
        this.lastScheduledWeek = range.start;
        this.nextWeeklyScheduleRetryAt = 0;
      } catch (error) {
        this.nextWeeklyScheduleRetryAt = Date.now() + 5 * 60 * 1000;
        errors.push(error);
      }
    }

    const dailyDue = this.config.dailyIpoEnabled
      && dueAt(this.config.dailyIpoHour, this.config.dailyIpoMinute)
      && this.lastScheduledDay !== local.dateKey
      && Date.now() >= this.nextDailyScheduleRetryAt;
    if (dailyDue) {
      try {
        await this.runDailyPush({ trigger: 'schedule', now });
        this.lastScheduledDay = local.dateKey;
        this.nextDailyScheduleRetryAt = 0;
      } catch (error) {
        this.nextDailyScheduleRetryAt = Date.now() + 5 * 60 * 1000;
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }

  async runWeeklyPush({ dryRun = false, retryFailed = false, trigger = 'manual', now = new Date() } = {}) {
    if (!this.ready) throw new Error('WeChat service is not ready');
    const range = weekRange(now, this.config.timezone);
    const payload = await this.loadIpoCalendar();
    const items = selectWeekIpos(payload.data, range);
    const content = buildWeeklyMessage(items, range, this.config.pageUrl);
    if (dryRun) return { dryRun: true, weekStart: range.start, weekEnd: range.end, ipoCount: items.length, content };
    return this.runPushJob({
      lockName: 'stock:wechat:weekly-ipo',
      jobKey: `weekly-ipo:${range.start}`,
      periodStart: range.start,
      periodEnd: range.end,
      ipoCount: items.length,
      content,
      scheduledFor: `${range.start} ${String(this.config.scheduleHour).padStart(2, '0')}:${String(this.config.scheduleMinute).padStart(2, '0')}:00`,
      retryFailed,
      trigger,
      resultFields: { weekStart: range.start, weekEnd: range.end },
    });
  }

  async runDailyPush({ dryRun = false, retryFailed = false, trigger = 'manual', now = new Date() } = {}) {
    if (!this.ready) throw new Error('WeChat service is not ready');
    const dateKey = zonedParts(now, this.config.timezone).dateKey;
    const payload = await this.loadIpoCalendar();
    const items = selectDailyIpos(payload.data, dateKey);
    const content = buildDailyMessage(items, dateKey, this.config.pageUrl);
    if (dryRun) return { dryRun: true, date: dateKey, ipoCount: items.length, content };
    if (!items.length) {
      return { accepted: false, date: dateKey, ipoCount: 0, reason: 'No stocks or convertible bonds available for subscription today' };
    }
    return this.runPushJob({
      lockName: 'stock:wechat:daily-ipo',
      jobKey: `daily-ipo:${dateKey}`,
      periodStart: dateKey,
      periodEnd: dateKey,
      ipoCount: items.length,
      content,
      scheduledFor: `${dateKey} ${String(this.config.dailyIpoHour).padStart(2, '0')}:${String(this.config.dailyIpoMinute).padStart(2, '0')}:00`,
      retryFailed,
      trigger,
      resultFields: { date: dateKey },
    });
  }

  async runPushJob({
    lockName,
    jobKey,
    periodStart,
    periodEnd,
    ipoCount,
    content,
    scheduledFor,
    retryFailed,
    trigger,
    resultFields,
  }) {
    if (this.running) return { accepted: false, reason: 'A push task is already running' };
    this.running = true;
    try {
      const lock = await this.database.withAdvisoryLock(lockName, async () => {
        const job = await this.database.createOrGetJob({
          jobKey,
          weekStart: periodStart,
          weekEnd: periodEnd,
          ipoCount,
          content,
          scheduledFor,
        });
        if (job.status === 'completed') {
          return { accepted: false, alreadyCompleted: true, jobId: job.id, ...resultFields };
        }
        const subscribers = await this.database.activeSubscribers();
        await this.database.startJob(job.id, subscribers.length);
        if (!subscribers.length) {
          const summary = await this.database.finishJob(job.id, 'No active subscribers');
          return { accepted: false, jobId: job.id, ipoCount, reason: 'No active subscribers', ...resultFields, ...summary };
        }
        for (const subscriber of subscribers) {
          const delivery = await this.database.ensureDelivery(job.id, subscriber.openid);
          if (delivery.status === 'sent') continue;
          if (delivery.status === 'sending' && !retryFailed) continue;
          if (delivery.status === 'failed' && !retryFailed && Number(delivery.attempt_count) > 0) continue;
          await this.database.markDeliverySending(delivery.id);
          try {
            await this.client.sendText(subscriber.openid, content);
            await this.database.markDeliverySent(delivery.id);
          } catch (error) {
            await this.database.markDeliveryFailed(delivery.id, error.errcode, error.message);
          }
          await delay(120);
        }
        const summary = await this.database.finishJob(job.id);
        return { accepted: true, trigger, jobId: job.id, ipoCount, recipients: subscribers.length, ...resultFields, ...summary };
      });
      return lock.locked ? lock.result : { accepted: false, reason: 'Another application instance owns the push lock' };
    } finally {
      this.running = false;
    }
  }
}

function createWechatService(options) {
  return new WeChatService(options);
}

module.exports = { createWechatService, WeChatService, buildDefaultMenu, signatureFor, safeEqual, readBody };
