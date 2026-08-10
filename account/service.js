'use strict';

const https = require('https');
const { loadAccountConfig } = require('./config');
const { AccountDatabase, MemoryAccountDatabase } = require('./database');
const {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validateUsername,
  validatePassword,
  validateDisplayName,
  validateAvatarData,
  safeAvatarUrl,
  sanitizePageConfig,
  randomToken,
  tokenHash,
} = require('./security');

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_NOTES_PER_USER = 200;
const MAX_NOTE_FOLDERS_PER_USER = 50;

function validateNoteFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80) {
    throw Object.assign(new Error('文件夹名称不能为空且不能超过 80 个字符'), { statusCode:400 });
  }
  return name;
}

async function resolveNoteFolderId(database, userId, value) {
  if (value == null || value === '') return null;
  const folderId = String(value);
  if (!/^\d+$/.test(folderId) || folderId === '0') {
    throw Object.assign(new Error('文件夹编号不正确'), { statusCode:400 });
  }
  const folder = await database.getNoteFolder(userId, folderId);
  if (!folder) throw Object.assign(new Error('文件夹不存在'), { statusCode:400 });
  return folder.id;
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(html);
}

function readJson(req, limit = 320 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        reject(Object.assign(new Error('请求 JSON 格式不正确'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch (_) { cookies[key] = value; }
  }
  return cookies;
}

function isSecureRequest(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded ? forwarded === 'https' : Boolean(req.socket?.encrypted);
}

function sessionCookie(config, token, expiresAt, secure) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(config, secure) {
  const parts = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch (_) {
    throw Object.assign(new Error('请求来源不可信'), { statusCode: 403 });
  }
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host;
  if (!host || parsed.host !== host) {
    throw Object.assign(new Error('请求来源不可信'), { statusCode: 403 });
  }
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`WeChat HTTP ${response.statusCode}`));
            return;
          }
          resolve(payload);
        } catch (error) {
          reject(new Error(`Invalid WeChat response: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => { request.destroy(new Error('WeChat request timeout')); });
    request.on('error', reject);
  });
}

function safeReturnTo(value) {
  const returnTo = String(value || '/');
  return returnTo.startsWith('/') && !returnTo.startsWith('//') && returnTo.length <= 500 ? returnTo : '/';
}

function publicUser(user) {
  return {
    id: String(user.id),
    username: user.username || null,
    displayName: user.display_name,
    avatarUrl: safeAvatarUrl(user.custom_avatar_data) || safeAvatarUrl(user.avatar_url),
    hasPassword: Boolean(user.password_hash),
    isAdmin: Number(user.is_admin) === 1,
  };
}

function publicSiteRecommendation(site) {
  let parsed;
  try { parsed = new URL(String(site.url || '')); }
  catch (_) { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return {
    id:String(site.id),
    name:String(site.name || '').trim().slice(0, 100),
    url:parsed.href,
    description:String(site.description || '').trim().slice(0, 255),
  };
}

function adminSiteRecommendation(site) {
  const publicSite = publicSiteRecommendation(site);
  if (!publicSite) return null;
  return {
    ...publicSite,
    sortOrder:Number(site.sort_order) || 0,
    isActive:Number(site.is_active) === 1,
    isAdminOnly:Number(site.is_admin_only) === 1,
    createdAt:site.created_at || null,
    updatedAt:site.updated_at || null,
  };
}

function validateSiteRecommendation(value) {
  const name = String(value?.name || '').trim();
  const description = String(value?.description || '').trim();
  if (!name || name.length > 100) {
    throw Object.assign(new Error('站点名称不能为空且不能超过 100 个字符'), { statusCode:400 });
  }
  if (description.length > 255) {
    throw Object.assign(new Error('站点说明不能超过 255 个字符'), { statusCode:400 });
  }
  let parsed;
  try { parsed = new URL(String(value?.url || '').trim()); }
  catch (_) { throw Object.assign(new Error('请输入完整有效的站点地址'), { statusCode:400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href.length > 500) {
    throw Object.assign(new Error('站点地址仅支持 500 个字符以内的 HTTP/HTTPS 链接'), { statusCode:400 });
  }
  const sortOrder = Number(value?.sortOrder ?? 0);
  if (!Number.isInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000) {
    throw Object.assign(new Error('排序值必须是 -100000 到 100000 的整数'), { statusCode:400 });
  }
  return {
    name,
    url:parsed.href,
    description,
    sortOrder,
    isActive:value?.isActive !== false,
    isAdminOnly:value?.isAdminOnly === true,
  };
}

function callbackPage(payload, returnTo = '/') {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const label = payload.ok ? '微信登录成功，正在返回页面…' : `微信登录失败：${payload.error || '请重试'}`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信登录</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0d1117;color:#e6edf3;font:15px system-ui}.card{padding:28px;border:1px solid #30363d;border-radius:12px;background:#161b22;text-align:center}.card a{display:inline-block;margin-top:16px;color:#58a6ff}</style></head><body><div class="card">${label}<br><a href="${returnTo.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">返回系统</a></div><script>const result=${serialized};if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'stock-auth-complete',...result},location.origin);setTimeout(()=>window.close(),500)}else if(result.ok){setTimeout(()=>location.replace(${JSON.stringify(returnTo)}),500)}</script></body></html>`;
}

class AccountService {
  constructor({ env = process.env, database = null } = {}) {
    this.config = loadAccountConfig(env);
    this.database = database || (this.config.driver === 'memory'
      ? new MemoryAccountDatabase()
      : new AccountDatabase(this.config.database));
    this.ready = false;
    this.initializationError = null;
    this.cleanupTimer = null;
    this.rateLimits = new Map();
  }

  async start() {
    if (!this.config.enabled) {
      console.log('Account service is disabled');
      return;
    }
    if (this.config.missing.length) {
      this.initializationError = `Missing configuration: ${this.config.missing.join(', ')}`;
      console.error(`Account initialization skipped: ${this.initializationError}`);
      return;
    }
    if (this.config.driver === 'memory' && process.env.NODE_ENV === 'production') {
      this.initializationError = 'The memory account driver is not allowed in production';
      console.error(`Account initialization skipped: ${this.initializationError}`);
      return;
    }
    try {
      await this.database.initialize();
      this.ready = true;
      console.log(`Account service ready (${this.config.driver}; WeChat login ${this.config.wechat.enabled ? 'enabled' : 'disabled'})`);
      this.cleanupTimer = setInterval(() => this.database.cleanup().catch(error => {
        console.error('Account cleanup failed:', error.message);
      }), 60 * 60 * 1000);
      this.cleanupTimer.unref();
    } catch (error) {
      this.initializationError = error.message;
      console.error('Account initialization failed:', error.message);
    }
  }

  async close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    if (this.ready) await this.database.close();
    this.ready = false;
  }

  rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let item = this.rateLimits.get(key);
    if (!item || item.resetAt <= now) item = { count: 0, resetAt: now + windowMs };
    item.count += 1;
    this.rateLimits.set(key, item);
    if (item.count > limit) throw Object.assign(new Error('尝试次数过多，请稍后再试'), { statusCode: 429 });
  }

  clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  }

  async sessionFromRequest(req) {
    const token = parseCookies(req)[this.config.cookieName];
    if (!token) return null;
    const session = await this.database.findSession(tokenHash(token));
    if (session) this.database.touchSession(session.session_id).catch(() => {});
    return session ? { token, tokenHash: tokenHash(token), user: session } : null;
  }

  async requireUser(req) {
    const session = await this.sessionFromRequest(req);
    if (!session) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    return session;
  }

  async requireAdmin(req) {
    const session = await this.requireUser(req);
    if (Number(session.user.is_admin) !== 1) {
      throw Object.assign(new Error('仅管理员可以执行此操作'), { statusCode:403 });
    }
    return session;
  }

  async loadFundFlowHistoryCache(symbol) {
    if (!this.ready || typeof this.database.getFundFlowHistoryCache !== 'function') return null;
    return this.database.getFundFlowHistoryCache(symbol);
  }

  async saveFundFlowHistoryCache(symbol, value) {
    if (!this.ready || typeof this.database.saveFundFlowHistoryCache !== 'function') return false;
    await this.database.saveFundFlowHistoryCache(symbol, value);
    return true;
  }

  async createChatMessage(userId, message) {
    if (!this.ready || typeof this.database.createChatMessage !== 'function') {
      throw Object.assign(new Error('聊天记录服务暂不可用'), { statusCode:503 });
    }
    return this.database.createChatMessage(userId, message);
  }

  async listChatMessages(options) {
    if (!this.ready || typeof this.database.listChatMessages !== 'function') {
      throw Object.assign(new Error('聊天记录服务暂不可用'), { statusCode:503 });
    }
    return this.database.listChatMessages(options);
  }

  async authPayload(user) {
    const config = await this.database.getPreferences(user.id);
    return {
      enabled: true,
      wechatEnabled: this.config.wechat.enabled,
      user: publicUser(user),
      config,
      needsConfigDecision: !user.config_decided_at && !config,
    };
  }

  async createLogin(user, req) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.config.sessionDays * 24 * 60 * 60 * 1000);
    await this.database.createSession({ userId: user.id, tokenHash: tokenHash(token), expiresAt });
    return { token, expiresAt, cookie: sessionCookie(this.config, token, expiresAt, isSecureRequest(req)) };
  }

  async handleRoute(req, res, urlObject) {
    const pathname = urlObject.pathname;
    // AI administration has its own service, but keeps this account service as
    // the authentication and persistence authority.
    if (pathname.startsWith('/api/admin/ai/')) return false;
    if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/notes') && !pathname.startsWith('/api/note-folders') && !pathname.startsWith('/api/admin/') && pathname !== '/api/site-recommendations') return false;

    try {
      if (pathname === '/api/site-recommendations') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error:'Method Not Allowed' }, { Allow:'GET' });
          return true;
        }
        if (!this.config.enabled || !this.ready) {
          sendJson(res, 503, { error:'站点推荐暂不可用' });
          return true;
        }
        const session = await this.sessionFromRequest(req);
        const includeAdminOnly = Number(session?.user?.is_admin) === 1;
        const sites = (await this.database.listSiteRecommendations({ includeAdminOnly }))
          .filter(site => includeAdminOnly || Number(site.is_admin_only) !== 1)
          .map(publicSiteRecommendation)
          .filter(site => site && site.name);
        sendJson(res, 200, { sites });
        return true;
      }

      if (pathname === '/api/auth/me' && req.method === 'GET') {
        if (!this.config.enabled) {
          sendJson(res, 200, { enabled: false, wechatEnabled: false, user: null, config: null, needsConfigDecision: false });
          return true;
        }
        if (!this.ready) {
          sendJson(res, 503, { enabled: true, ready: false, error: '账号服务暂不可用' });
          return true;
        }
        const session = await this.sessionFromRequest(req);
        sendJson(res, 200, session
          ? await this.authPayload(session.user)
          : { enabled: true, wechatEnabled: this.config.wechat.enabled, user: null, config: null, needsConfigDecision: false });
        return true;
      }

      if (!this.config.enabled || !this.ready) {
        if (pathname === '/api/auth/wechat/callback') {
          sendHtml(res, 503, callbackPage({ ok: false, error: '账号服务暂不可用' }));
        } else {
          sendJson(res, 503, { error: this.initializationError || '账号服务尚未启用' });
        }
        return true;
      }

      const adminUserRoleMatch = pathname.match(/^\/api\/admin\/users\/(\d{1,20})\/admin$/);
      if (adminUserRoleMatch) {
        if (req.method !== 'PUT') {
          sendJson(res, 405, { error:'Method Not Allowed' }, { Allow:'PUT' });
          return true;
        }
        assertSameOrigin(req);
        const session = await this.requireAdmin(req);
        const userId = adminUserRoleMatch[1];
        if (String(session.user.id) === userId) {
          throw Object.assign(new Error('不能修改自己的管理员身份'), { statusCode:400 });
        }
        const body = await readJson(req, 4096);
        if (typeof body.isAdmin !== 'boolean') {
          throw Object.assign(new Error('管理员授权状态不正确'), { statusCode:400 });
        }
        let user;
        try {
          user = await this.database.setUserAdmin({ userId, isAdmin:body.isAdmin });
        } catch (error) {
          if (error.code === 'LAST_ACTIVE_ADMIN') {
            throw Object.assign(new Error('系统必须至少保留一名启用中的管理员'), { statusCode:409 });
          }
          throw error;
        }
        if (!user) throw Object.assign(new Error('用户不存在或已停用'), { statusCode:404 });
        sendJson(res, 200, { user:publicUser(user), changed:true });
        return true;
      }

      const adminSitesMatch = pathname.match(/^\/api\/admin\/sites(?:\/(\d+))?$/);
      if (adminSitesMatch) {
        if (req.method !== 'GET') assertSameOrigin(req);
        await this.requireAdmin(req);
        const siteId = adminSitesMatch[1];

        if (!siteId && req.method === 'GET') {
          const sites = (await this.database.listAllSiteRecommendations())
            .map(adminSiteRecommendation)
            .filter(Boolean);
          sendJson(res, 200, { sites });
          return true;
        }

        if (!siteId && req.method === 'POST') {
          const input = validateSiteRecommendation(await readJson(req, 16 * 1024));
          try {
            const site = await this.database.createSiteRecommendation(input);
            sendJson(res, 201, { site:adminSiteRecommendation(site) });
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
              throw Object.assign(new Error('该站点地址已经存在'), { statusCode:409 });
            }
            throw error;
          }
          return true;
        }

        if (siteId && req.method === 'PUT') {
          const input = validateSiteRecommendation(await readJson(req, 16 * 1024));
          try {
            const site = await this.database.updateSiteRecommendation(siteId, input);
            if (!site) throw Object.assign(new Error('站点不存在'), { statusCode:404 });
            sendJson(res, 200, { site:adminSiteRecommendation(site) });
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
              throw Object.assign(new Error('该站点地址已经存在'), { statusCode:409 });
            }
            throw error;
          }
          return true;
        }

        if (siteId && req.method === 'DELETE') {
          const deleted = await this.database.deleteSiteRecommendation(siteId);
          if (!deleted) throw Object.assign(new Error('站点不存在'), { statusCode:404 });
          sendJson(res, 200, { deleted:true });
          return true;
        }

        sendJson(res, 405, { error:'Method Not Allowed' }, { Allow:siteId ? 'PUT, DELETE' : 'GET, POST' });
        return true;
      }

      if (pathname === '/api/auth/register' && req.method === 'POST') {
        assertSameOrigin(req);
        this.rateLimit(`register:${this.clientIp(req)}`, 10, 60 * 60 * 1000);
        const body = await readJson(req);
        const username = validateUsername(body.username);
        const password = validatePassword(body.password);
        const displayName = validateDisplayName(body.displayName, username);
        const passwordHash = await hashPassword(password);
        let user;
        try { user = await this.database.createPasswordUser({ username, passwordHash, displayName }); }
        catch (error) {
          if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('该账号已被注册'), { statusCode: 409 });
          throw error;
        }
        const login = await this.createLogin(user, req);
        sendJson(res, 201, await this.authPayload(user), { 'Set-Cookie': login.cookie });
        return true;
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        assertSameOrigin(req);
        const body = await readJson(req);
        const username = normalizeUsername(body.username);
        this.rateLimit(`login:${this.clientIp(req)}:${username}`, 12, 15 * 60 * 1000);
        const user = username ? await this.database.findUserByUsername(username) : null;
        const valid = Boolean(user && user.status === 'active' && user.password_hash
          && await verifyPassword(String(body.password || ''), user.password_hash));
        if (!valid) throw Object.assign(new Error('账号或密码错误'), { statusCode: 401 });
        await this.database.updateLastLogin(user.id);
        const refreshed = await this.database.findUserById(user.id);
        const login = await this.createLogin(refreshed, req);
        this.rateLimits.delete(`login:${this.clientIp(req)}:${username}`);
        sendJson(res, 200, await this.authPayload(refreshed), { 'Set-Cookie': login.cookie });
        return true;
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        assertSameOrigin(req);
        const session = await this.sessionFromRequest(req);
        if (session) await this.database.deleteSession(session.tokenHash);
        sendJson(res, 200, { loggedOut: true }, {
          'Set-Cookie': clearSessionCookie(this.config, isSecureRequest(req)),
        });
        return true;
      }

      if (pathname === '/api/auth/password' && req.method === 'PUT') {
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const body = await readJson(req);
        const newPassword = validatePassword(body.newPassword);
        let username = null;
        if (session.user.password_hash) {
          if (!await verifyPassword(String(body.currentPassword || ''), session.user.password_hash)) {
            throw Object.assign(new Error('当前密码不正确'), { statusCode: 400 });
          }
        } else {
          username = validateUsername(body.username);
        }
        const passwordHash = await hashPassword(newPassword);
        let user;
        try { user = await this.database.changePassword(session.user.id, { passwordHash, username }); }
        catch (error) {
          if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('该账号已被使用'), { statusCode: 409 });
          throw error;
        }
        sendJson(res, 200, { user: publicUser(user), changed: true });
        return true;
      }

      if (pathname === '/api/auth/avatar' && req.method === 'PUT') {
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const body = await readJson(req);
        const avatarData = body.remove === true ? null : validateAvatarData(body.avatarData);
        const user = await this.database.updateAvatar(session.user.id, avatarData);
        if (!user) throw Object.assign(new Error('账号不存在'), { statusCode:404 });
        sendJson(res, 200, { user:publicUser(user), changed:true });
        return true;
      }

      if (pathname === '/api/auth/profile' && req.method === 'PUT') {
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const body = await readJson(req, 4096);
        const requestedName = String(body.displayName || '').trim();
        if (!requestedName) throw Object.assign(new Error('显示名称不能为空'), { statusCode:400 });
        const displayName = validateDisplayName(requestedName, '用户');
        const user = await this.database.updateProfile(session.user.id, { displayName });
        if (!user) throw Object.assign(new Error('账号不存在'), { statusCode:404 });
        sendJson(res, 200, { user:publicUser(user), changed:true });
        return true;
      }

      if (pathname === '/api/auth/preferences' && req.method === 'PUT') {
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const body = await readJson(req);
        const config = sanitizePageConfig(body.config);
        await this.database.savePreferences(session.user.id, config);
        await this.database.markConfigDecided(session.user.id);
        sendJson(res, 200, { saved: true });
        return true;
      }

      if (pathname === '/api/auth/preferences/decision' && req.method === 'POST') {
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const body = await readJson(req);
        const imported = body.importCurrent === true;
        const config = imported ? sanitizePageConfig(body.config) : sanitizePageConfig({ values: {} });
        await this.database.savePreferences(session.user.id, config);
        await this.database.markConfigDecided(session.user.id);
        sendJson(res, 200, { saved: true, imported, config });
        return true;
      }

      if (pathname === '/api/auth/wechat/start' && req.method === 'GET') {
        if (!this.config.wechat.enabled) {
          sendHtml(res, 503, callbackPage({ ok: false, error: '微信扫码登录尚未配置' }));
          return true;
        }
        this.rateLimit(`wechat:${this.clientIp(req)}`, 30, 15 * 60 * 1000);
        const state = randomToken(24);
        const returnTo = safeReturnTo(urlObject.searchParams.get('return_to'));
        await this.database.createOAuthState({
          stateHash: tokenHash(state), provider: 'wechat', returnTo,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        const params = new URLSearchParams({
          appid: this.config.wechat.appId,
          redirect_uri: this.config.wechat.callbackUrl,
          response_type: 'code',
          scope: 'snsapi_login',
          state,
          lang: 'cn',
        });
        res.writeHead(302, { Location: `https://open.weixin.qq.com/connect/qrconnect?${params}#wechat_redirect`, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }

      if (pathname === '/api/auth/wechat/callback' && req.method === 'GET') {
        const state = String(urlObject.searchParams.get('state') || '');
        const code = String(urlObject.searchParams.get('code') || '');
        const savedState = state ? await this.database.consumeOAuthState(tokenHash(state)) : null;
        if (!savedState || savedState.provider !== 'wechat' || !code) {
          sendHtml(res, 400, callbackPage({ ok: false, error: '登录请求已失效，请重新扫码' }));
          return true;
        }
        const tokenParams = new URLSearchParams({
          appid: this.config.wechat.appId,
          secret: this.config.wechat.appSecret,
          code,
          grant_type: 'authorization_code',
        });
        const tokenPayload = await requestJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${tokenParams}`);
        if (tokenPayload.errcode || !tokenPayload.access_token || !tokenPayload.openid) {
          throw Object.assign(new Error(`微信授权失败（${tokenPayload.errcode || 'unknown'}）`), { statusCode: 502, oauthReturnTo: savedState.return_to });
        }
        const profileParams = new URLSearchParams({
          access_token: tokenPayload.access_token,
          openid: tokenPayload.openid,
          lang: 'zh_CN',
        });
        const profile = await requestJson(`https://api.weixin.qq.com/sns/userinfo?${profileParams}`);
        if (profile.errcode) {
          throw Object.assign(new Error(`读取微信用户信息失败（${profile.errcode}）`), { statusCode: 502, oauthReturnTo: savedState.return_to });
        }
        const unionid = tokenPayload.unionid || profile.unionid || null;
        const providerUserId = unionid || `${this.config.wechat.appId}:${tokenPayload.openid}`;
        const displayName = validateDisplayName(profile.nickname, '微信用户');
        const user = await this.database.upsertWechatUser({
          providerUserId,
          openid: tokenPayload.openid,
          unionid,
          displayName,
          avatarUrl: profile.headimgurl || null,
          profile: {
            nickname: profile.nickname || '',
            sex: profile.sex || 0,
            province: profile.province || '',
            city: profile.city || '',
            country: profile.country || '',
          },
        });
        const login = await this.createLogin(user, req);
        sendHtml(res, 200, callbackPage({ ok: true }, savedState.return_to), { 'Set-Cookie': login.cookie });
        return true;
      }

      // ---- Notes routes ----
      const notesMatch = pathname.match(/^\/api\/notes(?:\/(\d+))?$/);
      const isNotesImport = pathname === '/api/notes/import';
      const noteFoldersMatch = pathname.match(/^\/api\/note-folders(?:\/(\d+))?$/);

      if (notesMatch || isNotesImport || noteFoldersMatch) {
        if (!this.config.enabled || !this.ready) {
          sendJson(res, 503, { error: '账号服务尚未启用' });
          return true;
        }
        assertSameOrigin(req);
        const session = await this.requireUser(req);
        const userId = session.user.id;
        const noteId = notesMatch ? notesMatch[1] : null;
        const folderRouteId = noteFoldersMatch ? noteFoldersMatch[1] : null;

        if (noteFoldersMatch && !folderRouteId && req.method === 'GET') {
          const folders = await this.database.listNoteFolders(userId);
          sendJson(res, 200, { folders });
          return true;
        }

        if (noteFoldersMatch && !folderRouteId && req.method === 'POST') {
          const folders = await this.database.listNoteFolders(userId);
          if (folders.length >= MAX_NOTE_FOLDERS_PER_USER) {
            throw Object.assign(new Error(`文件夹数量已达上限（${MAX_NOTE_FOLDERS_PER_USER}个）`), { statusCode:400 });
          }
          const body = await readJson(req, 4096);
          const name = validateNoteFolderName(body.name);
          try {
            const folder = await this.database.createNoteFolder(userId, name);
            sendJson(res, 201, { folder });
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
              throw Object.assign(new Error('同名文件夹已存在'), { statusCode:409 });
            }
            throw error;
          }
          return true;
        }

        if (noteFoldersMatch && folderRouteId && req.method === 'GET') {
          const folder = await this.database.getNoteFolder(userId, folderRouteId);
          if (!folder) throw Object.assign(new Error('文件夹不存在'), { statusCode:404 });
          sendJson(res, 200, { folder });
          return true;
        }

        if (noteFoldersMatch && folderRouteId && req.method === 'PUT') {
          const body = await readJson(req, 4096);
          const name = validateNoteFolderName(body.name);
          try {
            const folder = await this.database.updateNoteFolder(userId, folderRouteId, name);
            if (!folder) throw Object.assign(new Error('文件夹不存在'), { statusCode:404 });
            sendJson(res, 200, { folder });
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
              throw Object.assign(new Error('同名文件夹已存在'), { statusCode:409 });
            }
            throw error;
          }
          return true;
        }

        if (noteFoldersMatch && folderRouteId && req.method === 'DELETE') {
          const deleted = await this.database.deleteNoteFolder(userId, folderRouteId);
          if (!deleted) throw Object.assign(new Error('文件夹不存在'), { statusCode:404 });
          sendJson(res, 200, { deleted:true, notesMovedToUnfiled:true });
          return true;
        }

        if (isNotesImport && req.method === 'POST') {
          const body = await readJson(req, MAX_NOTE_BYTES + 1024);
          const title = String(body.title || '').trim().slice(0, 200) || '导入的笔记';
          const content = String(body.content || '');
          const folderId = await resolveNoteFolderId(this.database, userId, body.folderId);
          if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
            throw Object.assign(new Error('笔记内容超过 1MB 限制'), { statusCode: 413 });
          }
          const existing = await this.database.listNotes(userId);
          if (existing.length >= MAX_NOTES_PER_USER) {
            throw Object.assign(new Error(`笔记数量已达上限（${MAX_NOTES_PER_USER}条）`), { statusCode: 400 });
          }
          const note = await this.database.createNote(userId, { title, content, folderId });
          sendJson(res, 201, { note });
          return true;
        }

        if (!noteId && req.method === 'GET') {
          const notes = await this.database.listNotes(userId);
          sendJson(res, 200, { notes });
          return true;
        }

        if (!noteId && req.method === 'POST') {
          const existing = await this.database.listNotes(userId);
          if (existing.length >= MAX_NOTES_PER_USER) {
            throw Object.assign(new Error(`笔记数量已达上限（${MAX_NOTES_PER_USER}条）`), { statusCode: 400 });
          }
          const body = await readJson(req, MAX_NOTE_BYTES + 1024);
          const title = String(body.title || '').trim().slice(0, 200);
          const content = String(body.content || '');
          const folderId = await resolveNoteFolderId(this.database, userId, body.folderId);
          if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
            throw Object.assign(new Error('笔记内容超过 1MB 限制'), { statusCode: 413 });
          }
          const note = await this.database.createNote(userId, { title, content, folderId });
          sendJson(res, 201, { note });
          return true;
        }

        if (noteId && req.method === 'GET') {
          const note = await this.database.getNote(userId, noteId);
          if (!note) throw Object.assign(new Error('笔记不存在'), { statusCode: 404 });
          sendJson(res, 200, { note });
          return true;
        }

        if (noteId && req.method === 'PUT') {
          const body = await readJson(req, MAX_NOTE_BYTES + 1024);
          const updates = {};
          if (body.title !== undefined) updates.title = String(body.title).trim().slice(0, 200);
          if (body.folderId !== undefined) {
            updates.folderId = await resolveNoteFolderId(this.database, userId, body.folderId);
          }
          if (body.content !== undefined) {
            updates.content = String(body.content);
            if (Buffer.byteLength(updates.content, 'utf8') > MAX_NOTE_BYTES) {
              throw Object.assign(new Error('笔记内容超过 1MB 限制'), { statusCode: 413 });
            }
          }
          const note = await this.database.updateNote(userId, noteId, updates);
          if (!note) throw Object.assign(new Error('笔记不存在'), { statusCode: 404 });
          sendJson(res, 200, { note });
          return true;
        }

        if (noteId && req.method === 'DELETE') {
          const deleted = await this.database.deleteNote(userId, noteId);
          if (!deleted) throw Object.assign(new Error('笔记不存在'), { statusCode: 404 });
          sendJson(res, 200, { deleted: true });
          return true;
        }
      }

      sendJson(res, 404, { error: 'Not Found' });
      return true;
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error('Account request failed:', error.message);
      if (!res.headersSent) {
        if (pathname === '/api/auth/wechat/callback') {
          sendHtml(res, status, callbackPage({ ok: false, error: status >= 500 ? '微信登录暂时不可用，请稍后重试' : error.message }, error.oauthReturnTo || '/'));
        } else {
          sendJson(res, status, { error: status >= 500 ? '账号服务处理失败' : error.message });
        }
      } else if (!res.writableEnded) {
        res.end();
      }
      return true;
    }
  }
}

function createAccountService(options) {
  return new AccountService(options);
}

module.exports = {
  AccountService,
  createAccountService,
  publicUser,
  publicSiteRecommendation,
  readJson,
  assertSameOrigin,
};
