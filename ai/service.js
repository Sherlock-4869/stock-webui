'use strict';

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { assertSameOrigin, readJson } = require('../account/service');

const MAX_MESSAGE_BYTES = 12 * 1024;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_HISTORY_FOR_AGENT = 16;
const AI_RATE_LIMIT = 6;
const AI_RATE_WINDOW_MS = 60 * 1000;
const AGENT_TIMEOUT_MS = 190 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 12 * 1000;
const MODEL_CATALOG_MAX_BYTES = 512 * 1024;
const MODEL_CATALOG_MAX_RESULTS = 200;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL_PATTERN = /^[a-zA-Z0-9._-]{2,24}$/;
const MODEL_ID_PATTERN = /^\d{1,20}$/;

function booleanValue(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadAiConfig(env = process.env) {
  const rawKey = String(env.STOCK_AI_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  let credentialKey = null;
  if (rawKey) {
    try {
      const candidate = Buffer.from(rawKey, 'base64');
      if (candidate.length === 32) credentialKey = candidate;
    } catch (_) {}
  }
  return {
    enabled:booleanValue(env.STOCK_AI_ENABLED, false),
    agentUrl:String(env.STOCK_AI_AGENT_URL || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
    internalToken:String(env.STOCK_AI_AGENT_INTERNAL_TOKEN || ''),
    credentialKey,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(payload));
}

function publicModel(row) {
  if (!row) return null;
  return {
    id:Number(row.id), name:String(row.name), modelName:String(row.model_name), baseUrl:String(row.base_url),
    protocol:String(row.protocol), isActive:Number(row.is_active) === 1,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function publicUserModel(row) {
  if (!row) return null;
  return {
    id:Number(row.id), name:String(row.name), modelName:String(row.model_name), baseUrl:String(row.base_url),
    protocol:String(row.protocol), isActive:Number(row.is_active) === 1,
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function publicConversation(row) {
  if (!row) return null;
  return {
    id:String(row.id), title:String(row.title), messageCount:Number(row.message_count || 0),
    createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function publicMessage(row) {
  if (!row) return null;
  return { id:String(row.id), role:String(row.role), content:String(row.content), status:String(row.status), createdAt:row.created_at };
}

function publicAiPermissionUser(row) {
  if (!row) return null;
  return {
    id:String(row.id),
    username:row.username || null,
    displayName:String(row.display_name || '用户'),
    status:String(row.status || 'active'),
    isAdmin:Number(row.is_admin) === 1,
    isGranted:Number(row.ai_chat_granted) === 1,
    grantedAt:row.ai_chat_granted_at || null,
    lastLoginAt:row.last_login_at || null,
    createdAt:row.created_at || null,
  };
}

function encryptionError() {
  return Object.assign(new Error('未配置有效的 STOCK_AI_CREDENTIAL_ENCRYPTION_KEY（需要 32 字节 Base64 密钥）'), { statusCode:503 });
}

function encryptCredential(value, config) {
  if (!config.credentialKey) throw encryptionError();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.credentialKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

function decryptCredential(value, config) {
  if (!config.credentialKey) throw encryptionError();
  const parts = String(value || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('模型密钥密文无效'), { statusCode:500 });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', config.credentialKey, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch (_) {
    throw Object.assign(new Error('无法解密模型密钥，请检查加密密钥是否被轮换'), { statusCode:500 });
  }
}

function validModelInput(body, { requireKey = true } = {}) {
  const name = String(body.name || '').trim().slice(0, 100);
  const modelName = String(body.modelName || '').trim().slice(0, 160);
  const baseUrl = String(body.baseUrl || '').trim().slice(0, 500).replace(/\/+$/, '');
  const apiKey = body.apiKey == null ? '' : String(body.apiKey).trim();
  if (!name || !modelName || !baseUrl) throw Object.assign(new Error('模型名称、模型标识和 Base URL 均不能为空'), { statusCode:400 });
  let parsed;
  try { parsed = new URL(baseUrl); } catch (_) { throw Object.assign(new Error('Base URL 格式不正确'), { statusCode:400 }); }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !loopback)) {
    throw Object.assign(new Error('Base URL 必须使用 HTTPS；本机兼容服务可使用 HTTP'), { statusCode:400 });
  }
  if (requireKey && !apiKey) throw Object.assign(new Error('API Key 不能为空'), { statusCode:400 });
  if (apiKey.length > 2000) throw Object.assign(new Error('API Key 长度不正确'), { statusCode:400 });
  if (body.protocol && body.protocol !== 'chat_completions') throw Object.assign(new Error('当前仅支持 OpenAI 兼容 Chat Completions 协议'), { statusCode:400 });
  return { name, modelName, baseUrl, apiKey, protocol:'chat_completions', isActive:body.isActive !== false };
}

function normalizedHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isPrivateIpAddress(value) {
  const address = normalizedHostname(value);
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
  }
  if (family === 6) {
    if (address === '::' || address === '::1' || address.startsWith('fe80:') || /^(fc|fd)/.test(address)) return true;
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return Boolean(mapped && isPrivateIpAddress(mapped[1]));
  }
  return true;
}

function validModelCatalogInput(body) {
  const baseUrl = String(body?.baseUrl || '').trim().slice(0, 500).replace(/\/+$/, '');
  const apiKey = String(body?.apiKey || '').trim();
  if (!baseUrl || !apiKey) throw Object.assign(new Error('请先填写 Base URL 和 API Key'), { statusCode:400 });
  if (apiKey.length > 2000) throw Object.assign(new Error('API Key 长度不正确'), { statusCode:400 });
  let parsed;
  try { parsed = new URL(baseUrl); } catch (_) { throw Object.assign(new Error('Base URL 格式不正确'), { statusCode:400 }); }
  if (parsed.username || parsed.password || parsed.hash) throw Object.assign(new Error('Base URL 不能包含账号信息或片段'), { statusCode:400 });
  if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname))) {
    throw Object.assign(new Error('模型目录接口必须使用 HTTPS；本机兼容服务可使用 HTTP'), { statusCode:400 });
  }
  return { baseUrl, apiKey };
}

async function resolveModelCatalogTarget(url) {
  const hostname = normalizedHostname(url.hostname);
  if (isLoopbackHostname(hostname)) {
    return { address:hostname === 'localhost' ? '127.0.0.1' : hostname, family:net.isIP(hostname) || 4 };
  }
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) throw Object.assign(new Error('模型目录接口不能指向内网地址'), { statusCode:400 });
    return { address:hostname, family:net.isIP(hostname) };
  }
  let addresses;
  try { addresses = await dns.promises.lookup(hostname, { all:true, verbatim:true }); }
  catch (_) { throw Object.assign(new Error('无法解析模型目录接口地址'), { statusCode:400 }); }
  if (!addresses.length || addresses.some(item => isPrivateIpAddress(item.address))) {
    throw Object.assign(new Error('模型目录接口不能指向内网地址'), { statusCode:400 });
  }
  return { address:addresses[0].address, family:addresses[0].family };
}

function modelCatalogUrl(baseUrl) {
  const url = new URL(`${String(baseUrl).replace(/\/+$/, '')}/models`);
  url.search = '';
  url.hash = '';
  return url;
}

function modelCatalogModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []);
  const seen = new Set();
  return entries.map(item => typeof item === 'string' ? item : (item?.id || item?.name || item?.model || ''))
    .map(item => String(item || '').trim().slice(0, 160))
    .filter(item => item && !/[\u0000-\u001f\u007f]/.test(item) && !seen.has(item) && seen.add(item))
    .slice(0, MODEL_CATALOG_MAX_RESULTS);
}

function validProviderModelName(value) {
  const modelName = String(value || '').trim().slice(0, 160);
  if (!modelName) return '';
  if (/[\u0000-\u001f\u007f]/.test(modelName)) throw Object.assign(new Error('所选模型标识无效'), { statusCode:400 });
  return modelName;
}

async function fetchModelCatalog({ baseUrl, apiKey }) {
  const url = modelCatalogUrl(baseUrl);
  const target = await resolveModelCatalogTarget(url);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname:target.address,
      port:url.port || undefined,
      family:target.family,
      servername:url.protocol === 'https:' ? normalizedHostname(url.hostname) : undefined,
      path:`${url.pathname}${url.search}`,
      method:'GET',
      headers:{ Accept:'application/json', Authorization:`Bearer ${apiKey}`, Host:url.host, 'User-Agent':'stock-monitor-model-catalog/1.0' },
      timeout:MODEL_CATALOG_TIMEOUT_MS,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MODEL_CATALOG_MAX_BYTES) {
          request.destroy(Object.assign(new Error('模型目录响应过大'), { statusCode:502 }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(new Error(`模型目录接口返回 HTTP ${response.statusCode}`), { statusCode:502 }));
          return;
        }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) { reject(Object.assign(new Error('模型目录接口未返回 JSON 数据'), { statusCode:502 })); return; }
        const models = modelCatalogModels(payload);
        if (!models.length) {
          reject(Object.assign(new Error('模型目录接口没有返回可用模型'), { statusCode:502 }));
          return;
        }
        resolve(models);
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('获取模型目录超时'), { statusCode:504 })));
    request.on('error', error => reject(error.statusCode ? error : Object.assign(new Error('获取模型目录失败'), { statusCode:502 })));
    request.end();
  });
}

function normalizedStockContext(value) {
  const source = value && typeof value === 'object' ? value : {};
  const symbols = Array.isArray(source.symbols) ? source.symbols : [];
  const safeSymbols = [...new Set(symbols.map(item => String(item || '').trim()).filter(symbol => SYMBOL_PATTERN.test(symbol)))].slice(0, 20);
  const activeSymbol = SYMBOL_PATTERN.test(String(source.activeSymbol || '')) ? String(source.activeSymbol) : null;
  return { symbols:safeSymbols, activeSymbol };
}

function agentPayloadSignature(token, timestamp, body) {
  return crypto.createHmac('sha256', token).update(timestamp).update('.').update(body).digest('hex');
}

class AiService {
  constructor({ accountService, config = loadAiConfig(), now = () => Date.now() } = {}) {
    this.accountService = accountService;
    this.config = config;
    this.now = now;
    this.rates = new Map();
  }

  async featureSetting() {
    return this.accountService.database.getAiFeatureSetting();
  }

  async accessFor(user) {
    const setting = await this.featureSetting();
    const isAdmin = Number(user?.is_admin) === 1;
    const isPublic = Number(setting.is_public) === 1;
    const isGranted = !isAdmin && await this.accountService.database.hasAiUserPermission(user?.id);
    const configured = Boolean(this.config.enabled && this.config.internalToken && this.config.credentialKey);
    const [globalModels, userModels] = await Promise.all([
      this.accountService.database.listActiveAiModelConfigs(),
      this.accountService.database.listActiveUserAiModelConfigs(user?.id),
    ]);
    const hasGlobalModel = globalModels.length > 0;
    const hasUserModel = userModels.length > 0;
    const hasFeaturePermission = isPublic || isAdmin || isGranted;
    // A user-owned model takes precedence, but every model source still
    // requires the AI feature to be granted to the current account.
    const modelSource = hasUserModel ? 'user' : (hasGlobalModel ? 'global' : null);
    const canUse = configured && hasFeaturePermission && Boolean(modelSource);
    return {
      enabled:configured, isPublic, isGranted, isAdmin, canUse,
      hasGlobalModel, hasUserModel,
      modelSource,
      needsUserModel:configured && hasFeaturePermission && !hasUserModel && !hasGlobalModel,
      models:(modelSource === 'user' ? userModels : globalModels).map(modelSource === 'user' ? publicUserModel : publicModel),
    };
  }

  checkRate(userId) {
    const now = this.now();
    const recent = (this.rates.get(String(userId)) || []).filter(time => now - time < AI_RATE_WINDOW_MS);
    if (recent.length >= AI_RATE_LIMIT) throw Object.assign(new Error('问股请求过于频繁，请稍后再试'), { statusCode:429 });
    recent.push(now);
    this.rates.set(String(userId), recent);
  }

  async requireAccount(req) {
    if (!this.accountService?.config?.enabled || !this.accountService.ready) {
      throw Object.assign(new Error('账号服务尚未启用，暂不能使用问股'), { statusCode:503 });
    }
    return this.accountService.requireUser(req);
  }

  async requireFeatureAccess(req) {
    const session = await this.requireAccount(req);
    const access = await this.accessFor(session.user);
    if (!access.canUse) throw Object.assign(new Error(access.enabled ? '你暂未获得问股页面权限' : '问股服务尚未完成配置'), { statusCode:403 });
    return { session, access };
  }

  async handleRoute(req, res, urlObj) {
    const pathname = urlObj.pathname;
    if (!pathname.startsWith('/api/ai/') && !pathname.startsWith('/api/admin/ai/')) return false;
    try {
      if (pathname.startsWith('/api/admin/ai/')) return await this.handleAdminRoute(req, res, urlObj);
      const session = await this.requireAccount(req);
      const userId = session.user.id;
      if (pathname === '/api/ai/access' && req.method === 'GET') {
        sendJson(res, 200, await this.accessFor(session.user));
        return true;
      }

      if (pathname === '/api/ai/user-models' && req.method === 'GET') {
        const models = await this.accountService.database.listUserAiModelConfigs(userId);
        sendJson(res, 200, { models:models.map(publicUserModel) });
        return true;
      }
      if (pathname === '/api/ai/user-models' && req.method === 'POST') {
        assertSameOrigin(req);
        const input = validModelInput(await readJson(req, 8192));
        const model = await this.accountService.database.createUserAiModelConfig(userId, {
          ...input, apiKeyEncrypted:encryptCredential(input.apiKey, this.config),
        });
        sendJson(res, 201, { model:publicUserModel(model) });
        return true;
      }
      if (pathname === '/api/ai/model-catalog' && req.method === 'POST') {
        assertSameOrigin(req);
        const input = validModelCatalogInput(await readJson(req, 4096));
        const models = await fetchModelCatalog(input);
        sendJson(res, 200, { models });
        return true;
      }
      const savedModelCatalogMatch = pathname.match(/^\/api\/ai\/models\/(\d{1,20})\/catalog$/);
      if (savedModelCatalogMatch && req.method === 'POST') {
        assertSameOrigin(req);
        await readJson(req, 512);
        const access = await this.accessFor(session.user);
        if (!access.canUse) throw Object.assign(new Error('你暂未获得问股页面权限'), { statusCode:403 });
        const models = await this.activeModelsFor(session.user.id, access);
        const model = models.find(item => String(item.id) === savedModelCatalogMatch[1]);
        if (!model) throw Object.assign(new Error('所选 AI 模型不可用'), { statusCode:400 });
        const catalog = await fetchModelCatalog({ baseUrl:model.base_url, apiKey:decryptCredential(model.api_key_encrypted, this.config) });
        sendJson(res, 200, { modelId:String(model.id), models:catalog });
        return true;
      }
      const userModelMatch = pathname.match(/^\/api\/ai\/user-models\/(\d{1,20})$/);
      if (userModelMatch && req.method === 'PUT') {
        assertSameOrigin(req);
        const existing = await this.accountService.database.getUserAiModelConfig(userId, userModelMatch[1]);
        if (!existing) throw Object.assign(new Error('模型配置不存在'), { statusCode:404 });
        const body = await readJson(req, 8192);
        const input = validModelInput({ ...body, apiKey:body.apiKey || 'kept' }, { requireKey:false });
        const model = await this.accountService.database.updateUserAiModelConfig(userId, userModelMatch[1], {
          ...input, apiKeyEncrypted:body.apiKey ? encryptCredential(body.apiKey, this.config) : null,
        });
        sendJson(res, 200, { model:publicUserModel(model) });
        return true;
      }
      if (userModelMatch && req.method === 'DELETE') {
        assertSameOrigin(req);
        let deleted;
        try {
          deleted = await this.accountService.database.deleteUserAiModelConfig(userId, userModelMatch[1]);
        } catch (error) {
          if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
            throw Object.assign(new Error('该模型已有使用记录，为保留审计数据不能删除；请改为停用'), { statusCode:409 });
          }
          throw error;
        }
        if (!deleted) throw Object.assign(new Error('模型配置不存在'), { statusCode:404 });
        sendJson(res, 200, { deleted:true });
        return true;
      }

      const access = await this.accessFor(session.user);
      if (!access.canUse) throw Object.assign(new Error(access.enabled ? '你暂未获得问股页面权限' : '问股服务尚未完成配置'), { statusCode:403 });

      if (pathname === '/api/ai/conversations' && req.method === 'GET') {
        const conversations = await this.accountService.database.listAiConversations(userId);
        sendJson(res, 200, { conversations:conversations.map(publicConversation) });
        return true;
      }
      if (pathname === '/api/ai/conversations' && req.method === 'POST') {
        assertSameOrigin(req);
        const body = await readJson(req, 4096);
        const title = String(body.title || '').trim().slice(0, 160) || '新问股会话';
        const conversation = await this.accountService.database.createAiConversation(userId, { id:crypto.randomUUID(), title });
        sendJson(res, 201, { conversation:publicConversation(conversation) });
        return true;
      }

      const conversationMatch = pathname.match(/^\/api\/ai\/conversations\/([0-9a-f-]{36})(?:\/(messages)(?:\/(stream))?)?$/i);
      if (!conversationMatch) { sendJson(res, 404, { error:'Not Found' }); return true; }
      const [, conversationId, messagesPart, streamPart] = conversationMatch;
      if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw Object.assign(new Error('会话编号不正确'), { statusCode:400 });
      const conversation = await this.accountService.database.getAiConversation(userId, conversationId);
      if (!conversation) throw Object.assign(new Error('会话不存在'), { statusCode:404 });

      if (!messagesPart && req.method === 'DELETE') {
        assertSameOrigin(req);
        await this.accountService.database.deleteAiConversation(userId, conversationId);
        sendJson(res, 200, { deleted:true });
        return true;
      }
      if (!messagesPart && req.method === 'PUT') {
        assertSameOrigin(req);
        const body = await readJson(req, 4096);
        const title = String(body.title || '').trim().slice(0, 160);
        if (!title) throw Object.assign(new Error('会话标题不能为空'), { statusCode:400 });
        const updated = await this.accountService.database.updateAiConversation(userId, conversationId, { title });
        sendJson(res, 200, { conversation:publicConversation(updated) });
        return true;
      }
      if (messagesPart && !streamPart && req.method === 'GET') {
        const messages = await this.accountService.database.listAiMessages(userId, conversationId);
        sendJson(res, 200, { conversation:publicConversation(conversation), messages:messages.map(publicMessage) });
        return true;
      }
      if (messagesPart && streamPart && req.method === 'POST') {
        assertSameOrigin(req);
        const body = await readJson(req, MAX_MESSAGE_BYTES);
        const message = String(body.message || '').trim();
        if (!message || message.length > MAX_MESSAGE_LENGTH) throw Object.assign(new Error(`问题不能为空且不能超过 ${MAX_MESSAGE_LENGTH} 个字符`), { statusCode:400 });
        this.checkRate(userId);
        const modelId = String(body.modelId || '').trim();
        if (modelId && !MODEL_ID_PATTERN.test(modelId)) throw Object.assign(new Error('所选 AI 模型无效'), { statusCode:400 });
        const providerModel = validProviderModelName(body.providerModel);
        await this.streamAgent(req, res, { session, access, conversation, message, modelId, providerModel, stockContext:normalizedStockContext(body.stockContext) });
        return true;
      }
      sendJson(res, 405, { error:'Method Not Allowed' });
      return true;
    } catch (error) {
      const isCatalogRequest = pathname === '/api/ai/model-catalog' || pathname === '/api/admin/ai/model-catalog' || /^\/api\/ai\/models\/\d{1,20}\/catalog$/.test(pathname);
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error:error.statusCode && (error.statusCode < 500 || isCatalogRequest) ? error.message : '问股服务处理失败' });
      return true;
    }
  }

  async handleAdminRoute(req, res, urlObj) {
    if (!this.accountService?.config?.enabled || !this.accountService.ready) throw Object.assign(new Error('账号服务尚未启用'), { statusCode:503 });
    const session = await this.accountService.requireAdmin(req);
    const pathname = urlObj.pathname;
    if (pathname === '/api/admin/ai/settings') {
      if (req.method === 'GET') {
        const setting = await this.featureSetting();
        sendJson(res, 200, { isPublic:Number(setting.is_public) === 1, configured:Boolean(this.config.enabled && this.config.internalToken && this.config.credentialKey) });
        return true;
      }
      if (req.method === 'PUT') {
        assertSameOrigin(req);
        const body = await readJson(req, 4096);
        const setting = await this.accountService.database.setAiFeatureSetting({ isPublic:body.isPublic === true, updatedByUserId:session.user.id });
        sendJson(res, 200, { isPublic:Number(setting.is_public) === 1 });
        return true;
      }
    }
    if (pathname === '/api/admin/ai/users' && req.method === 'GET') {
      const users = await this.accountService.database.listAiPermissionUsers();
      sendJson(res, 200, { users:users.map(publicAiPermissionUser).filter(Boolean) });
      return true;
    }
    const userPermissionMatch = pathname.match(/^\/api\/admin\/ai\/users\/(\d{1,20})\/permission$/);
    if (userPermissionMatch && req.method === 'PUT') {
      assertSameOrigin(req);
      const userId = userPermissionMatch[1];
      const targetUser = await this.accountService.database.findUserById(userId);
      if (!targetUser || targetUser.status !== 'active') throw Object.assign(new Error('用户不存在或已停用'), { statusCode:404 });
      if (Number(targetUser.is_admin) === 1) {
        throw Object.assign(new Error('管理员默认拥有问股权限，无需单独授权'), { statusCode:400 });
      }
      const body = await readJson(req, 4096);
      if (typeof body.canUse !== 'boolean') throw Object.assign(new Error('授权状态不正确'), { statusCode:400 });
      const isGranted = await this.accountService.database.setAiUserPermission({
        userId, canUse:body.canUse, grantedByUserId:session.user.id,
      });
      sendJson(res, 200, { userId:String(userId), isGranted });
      return true;
    }
    if (pathname === '/api/admin/ai/models' && req.method === 'GET') {
      const models = await this.accountService.database.listAiModelConfigs();
      sendJson(res, 200, { models:models.map(publicModel) });
      return true;
    }
    if (pathname === '/api/admin/ai/models' && req.method === 'POST') {
      assertSameOrigin(req);
      const input = validModelInput(await readJson(req, 8192));
      const model = await this.accountService.database.createAiModelConfig({
        ...input, apiKeyEncrypted:encryptCredential(input.apiKey, this.config), createdByUserId:session.user.id,
      });
      sendJson(res, 201, { model:publicModel(model) });
      return true;
    }
    if (pathname === '/api/admin/ai/model-catalog' && req.method === 'POST') {
      assertSameOrigin(req);
      const input = validModelCatalogInput(await readJson(req, 4096));
      const models = await fetchModelCatalog(input);
      sendJson(res, 200, { models });
      return true;
    }
    const modelMatch = pathname.match(/^\/api\/admin\/ai\/models\/(\d{1,20})$/);
    if (modelMatch && req.method === 'PUT') {
      assertSameOrigin(req);
      const existing = await this.accountService.database.getAiModelConfig(modelMatch[1]);
      if (!existing) throw Object.assign(new Error('模型配置不存在'), { statusCode:404 });
      const body = await readJson(req, 8192);
      const input = validModelInput({ ...body, apiKey:body.apiKey || 'kept' }, { requireKey:false });
      const model = await this.accountService.database.updateAiModelConfig(modelMatch[1], {
        ...input, apiKeyEncrypted:body.apiKey ? encryptCredential(body.apiKey, this.config) : null,
      });
      sendJson(res, 200, { model:publicModel(model) });
      return true;
    }
    if (modelMatch && req.method === 'DELETE') {
      assertSameOrigin(req);
      let deleted;
      try {
        deleted = await this.accountService.database.deleteAiModelConfig(modelMatch[1]);
      } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
          throw Object.assign(new Error('模型仍被历史记录关联，请完成数据库迁移后重试'), { statusCode:409 });
        }
        throw error;
      }
      if (!deleted) throw Object.assign(new Error('模型配置不存在'), { statusCode:404 });
      sendJson(res, 200, { deleted:true });
      return true;
    }
    if (pathname === '/api/admin/ai/usage' && req.method === 'GET') {
      const days = Number.parseInt(urlObj.searchParams.get('days') || '30', 10);
      sendJson(res, 200, await this.accountService.database.getAiUsageDashboard({ days }));
      return true;
    }
    sendJson(res, 404, { error:'Not Found' });
    return true;
  }

  async activeModelsFor(userId, access) {
    return access.modelSource === 'user'
      ? this.accountService.database.listActiveUserAiModelConfigs(userId)
      : this.accountService.database.listActiveAiModelConfigs();
  }

  async streamAgent(req, res, { session, access, conversation, message, modelId, providerModel, stockContext }) {
    if (!this.config.enabled || !this.config.internalToken) throw Object.assign(new Error('问股服务尚未完成配置'), { statusCode:503 });
    const modelSource = access.modelSource;
    const availableModels = await this.activeModelsFor(session.user.id, access);
    const model = modelId
      ? availableModels.find(item => String(item.id) === modelId)
      : availableModels[0];
    if (!model && modelId) throw Object.assign(new Error('所选 AI 模型不可用'), { statusCode:400 });
    if (!model) throw Object.assign(new Error('请等待管理员配置全局模型，或先在“我的 AI 模型”中配置自己的模型'), { statusCode:503 });
    const apiKey = decryptCredential(model.api_key_encrypted, this.config);
    const effectiveModelName = providerModel || model.model_name;
    const previousMessages = await this.accountService.database.listAiMessages(session.user.id, conversation.id, MAX_HISTORY_FOR_AGENT);
    const userMessage = await this.accountService.database.createAiMessage(conversation.id, { role:'user', content:message });
    if (previousMessages.length === 0) {
      await this.accountService.database.updateAiConversation(session.user.id, conversation.id, { title:message.slice(0, 40) });
    }
    const payload = Buffer.from(JSON.stringify({
      request_id:crypto.randomUUID(), conversation_id:conversation.id, message,
      history:previousMessages.map(item => ({ role:item.role, content:item.content })), summary:String(conversation.summary || ''),
      stock_context:stockContext,
      model:{ id:String(model.id), name:model.name, model:effectiveModelName, base_url:model.base_url, api_key:apiKey, protocol:model.protocol },
    }));
    const agentUrl = new URL(`${this.config.agentUrl}/internal/v1/chat/stream`);
    const transport = agentUrl.protocol === 'https:' ? https : http;
    const timestamp = String(Math.floor(this.now() / 1000));
    const headers = {
      'Content-Type':'application/json', 'Content-Length':payload.length,
      'X-Stock-Agent-Timestamp':timestamp,
      'X-Stock-Agent-Signature':agentPayloadSignature(this.config.internalToken, timestamp, payload),
    };

    await new Promise((resolve, reject) => {
      let upstream;
      let completed = false;
      let sseBuffer = '';
      const finalize = async event => {
        if (completed || !event || event.type !== 'done') return;
        completed = true;
        const assistant = await this.accountService.database.createAiMessage(conversation.id, { role:'assistant', content:String(event.content || ''), status:event.success === false ? 'failed' : 'complete' });
        const usage = event.usage || {};
        await this.accountService.database.recordAiUsage({
          userId:session.user.id, conversationId:conversation.id, messageId:assistant.id,
          modelConfigId:modelSource === 'global' ? model.id : null,
          userModelConfigId:modelSource === 'user' ? model.id : null,
          provider:String(event.provider || 'openai_compatible'), modelName:String(event.model || effectiveModelName),
          inputTokens:Number(usage.input_tokens) || 0, outputTokens:Number(usage.output_tokens) || 0, totalTokens:Number(usage.total_tokens) || 0,
        });
      };
      let eventQueue = Promise.resolve();
      const consumeEvents = async chunk => {
        sseBuffer += chunk;
        let boundary;
        while ((boundary = sseBuffer.indexOf('\n\n')) >= 0) {
          const block = sseBuffer.slice(0, boundary); sseBuffer = sseBuffer.slice(boundary + 2);
          const line = block.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          try { await finalize(JSON.parse(line.slice(6))); } catch (_) {}
        }
      };
      try {
        upstream = transport.request({ hostname:agentUrl.hostname, port:agentUrl.port || undefined, path:`${agentUrl.pathname}${agentUrl.search}`, method:'POST', headers, timeout:AGENT_TIMEOUT_MS }, response => {
          if (response.statusCode !== 200) {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => reject(Object.assign(new Error(`智能体服务不可用（HTTP ${response.statusCode}）`), { statusCode:502 })));
            return;
          }
          res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
          response.on('data', chunk => {
            eventQueue = eventQueue.then(() => consumeEvents(chunk.toString('utf8'))).catch(() => {});
            if (!res.writableEnded && !res.destroyed) res.write(chunk);
          });
          response.on('end', async () => {
            await eventQueue;
            if (!res.writableEnded) res.end();
            resolve();
          });
          response.on('error', reject);
        });
        upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('智能体服务响应超时'), { statusCode:504 })));
        upstream.on('error', reject);
        // `IncomingMessage.close` can fire after its request body is consumed;
        // only the response close reliably represents a disconnected browser.
        res.once('close', () => { if (!completed) upstream.destroy(); });
        upstream.end(payload);
      } catch (error) { reject(error); }
    }).catch(error => {
      if (!res.headersSent) throw error;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type:'error', error_code:'agent_unavailable', message:'智能体服务暂时不可用，请稍后重试' })}\n\n`);
        res.end();
      }
    });
    void userMessage;
  }
}

function createAiService(options) { return new AiService(options); }

module.exports = {
  AiService, createAiService, loadAiConfig, encryptCredential, decryptCredential, agentPayloadSignature,
  validModelCatalogInput, modelCatalogUrl, modelCatalogModels, validProviderModelName,
};
