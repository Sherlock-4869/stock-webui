'use strict';

const crypto = require('crypto');
const { assertSameOrigin } = require('../account/service');

const MAX_MESSAGE_LENGTH = 500;
const MAX_IMAGE_BYTES = 768 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096;
const MAX_CONNECTIONS = 200;
const MAX_CONNECTIONS_PER_USER = 3;
const MESSAGE_RATE_LIMIT = 8;
const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
const IMAGE_RATE_LIMIT = 3;
const IMAGE_RATE_WINDOW_MS = 60 * 1000;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(Object.assign(new Error('请求 JSON 格式不正确'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function chatUser(sessionUser) {
  if (!sessionUser) return null;
  const avatarUrl = String(sessionUser.avatar_url || '');
  return {
    userId: String(sessionUser.id),
    displayName: String(sessionUser.display_name || sessionUser.username || '用户').slice(0, 80),
    avatarUrl: /^(?:https?:\/\/|\/)/i.test(avatarUrl) ? avatarUrl : null,
    isAdmin: Number(sessionUser.is_admin) === 1,
  };
}

function shanghaiYesterdayStart(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const yesterday = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - 86400000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')} 00:00:00.000`;
}

function storedChatMessage(row) {
  if (!row) return null;
  const type = row.message_type === 'image' ? 'image' : 'text';
  const time = new Date(row.created_at).getTime();
  const message = {
    id:String(row.id),
    type,
    displayName:String(row.display_name || '用户').slice(0, 80),
    avatarUrl:/^(?:https?:\/\/|\/)/i.test(String(row.avatar_url || '')) ? String(row.avatar_url) : null,
    userId:String(row.user_id),
    isGuest:false,
    time:Number.isFinite(time) ? time : Date.now(),
  };
  if (type === 'image') {
    message.imageData = String(row.image_data || '');
    message.imageMime = String(row.image_mime || '');
  } else {
    message.text = String(row.text_content || '').slice(0, MAX_MESSAGE_LENGTH);
  }
  return message;
}

function validImageSignature(mimeType, buffer) {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function parseChatImage(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !CHAT_IMAGE_TYPES.has(match[1])) {
    throw Object.assign(new Error('仅支持 JPEG、PNG、GIF 或 WebP 图片'), { statusCode: 400 });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('图片为空或超过 768KB 限制'), { statusCode: 413 });
  }
  if (buffer.toString('base64') !== match[2] || !validImageSignature(match[1], buffer)) {
    throw Object.assign(new Error('图片内容或格式不正确'), { statusCode: 400 });
  }
  return {
    mimeType: match[1],
    dataUrl: `data:${match[1]};base64,${match[2]}`,
  };
}

class ChatService {
  constructor({ now = () => Date.now(), saveMessage = null, listMessages = null } = {}) {
    this.clients = new Map();
    this.messageRates = new Map();
    this.imageRates = new Map();
    this.now = now;
    this.saveMessage = saveMessage;
    this.listMessages = listMessages;
  }

  onlineCount() {
    return new Set([...this.clients.values()].map(client => client.user.userId)).size;
  }

  onlineUsers() {
    const users = new Map();
    for (const client of this.clients.values()) {
      const existing = users.get(client.user.userId);
      if (existing) {
        existing.connections += 1;
        existing.connectedAt = Math.min(existing.connectedAt, client.connectedAt);
        continue;
      }
      users.set(client.user.userId, {
        userId:client.user.userId,
        displayName:client.user.displayName,
        avatarUrl:client.user.avatarUrl,
        connections:1,
        connectedAt:client.connectedAt,
      });
    }
    return [...users.values()].sort((a, b) => a.connectedAt - b.connectedAt || a.userId.localeCompare(b.userId));
  }

  userConnectionCount(userId) {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.user.userId === userId) count += 1;
    }
    return count;
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      const res = client.res;
      if (res.writableEnded || res.destroyed) {
        client.cleanup();
        continue;
      }
      try {
        res.write(payload);
        if (Number(res.writableLength || 0) > MAX_SSE_BUFFER_BYTES) res.end();
      } catch (_) {
        client.cleanup();
      }
    }
  }

  checkMessageRate(userId) {
    const now = this.now();
    if (this.messageRates.size > 1000) {
      for (const [key, timestamps] of this.messageRates) {
        if (!timestamps.some(time => now - time < MESSAGE_RATE_WINDOW_MS)) this.messageRates.delete(key);
      }
    }
    const recent = (this.messageRates.get(userId) || []).filter(time => now - time < MESSAGE_RATE_WINDOW_MS);
    if (recent.length >= MESSAGE_RATE_LIMIT) {
      throw Object.assign(new Error('发送过于频繁，请稍后再试'), { statusCode: 429 });
    }
    recent.push(now);
    this.messageRates.set(userId, recent);
  }

  checkImageRate(userId) {
    const now = this.now();
    const recent = (this.imageRates.get(userId) || []).filter(time => now - time < IMAGE_RATE_WINDOW_MS);
    if (recent.length >= IMAGE_RATE_LIMIT) {
      throw Object.assign(new Error('图片发送过于频繁，请稍后再试'), { statusCode: 429 });
    }
    recent.push(now);
    this.imageRates.set(userId, recent);
  }

  openStream(req, res, user) {
    if (this.clients.size >= MAX_CONNECTIONS || this.userConnectionCount(user.userId) >= MAX_CONNECTIONS_PER_USER) {
      sendJson(res, 429, { error: '聊天室连接数已达上限，请稍后重试' });
      return;
    }

    const clientId = crypto.randomUUID();
    const wasOnline = this.userConnectionCount(user.userId) > 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let cleaned = false;
    let heartbeat = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      this.clients.delete(clientId);
      const stillOnline = this.userConnectionCount(user.userId) > 0;
      this.broadcast('online', { count: this.onlineCount() });
      if (!stillOnline) {
        this.broadcast('system', { text: `${user.displayName} 离开了聊天室`, time: this.now() });
      }
    };

    this.clients.set(clientId, { res, user, cleanup, connectedAt:this.now() });
    res.write(`event: connected\ndata: ${JSON.stringify({
      clientId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      userId: user.userId,
      online: this.onlineCount(),
    })}\n\n`);
    this.broadcast('online', { count: this.onlineCount() });
    if (!wasOnline) {
      this.broadcast('system', { text: `${user.displayName} 加入了聊天室`, time: this.now() });
    }

    heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
        if (Number(res.writableLength || 0) > MAX_SSE_BUFFER_BYTES) res.end();
      } catch (_) {
        cleanup();
      }
    }, 25000);
    heartbeat.unref?.();

    req.once('close', cleanup);
    req.once('error', cleanup);
    res.once?.('close', cleanup);
    res.once?.('error', cleanup);
  }

  async handleRoute(req, res, urlObj, sessionUser) {
    const pathname = urlObj.pathname;
    if (!pathname.startsWith('/api/chat')) return false;

    const user = chatUser(sessionUser);
    if (!user) {
      sendJson(res, 401, { error: '请先登录后进入聊天室' });
      return true;
    }

    if (pathname === '/api/chat/stream' && req.method === 'GET') {
      this.openStream(req, res, user);
      return true;
    }

    if (pathname === '/api/chat/send' && req.method === 'POST') {
      assertSameOrigin(req);
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        throw Object.assign(new Error('仅支持 JSON 请求'), { statusCode: 415 });
      }
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const imageData = typeof body.imageData === 'string' ? body.imageData : '';
      if (Number(Boolean(text)) + Number(Boolean(imageData)) !== 1) {
        throw Object.assign(new Error('请发送文字或一张图片'), { statusCode: 400 });
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        throw Object.assign(new Error('文字消息超过 500 字限制'), { statusCode: 400 });
      }
      this.checkMessageRate(user.userId);
      const image = imageData ? parseChatImage(imageData) : null;
      if (image) this.checkImageRate(user.userId);
      let msg = {
        id: crypto.randomUUID(),
        type: image ? 'image' : 'text',
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        userId: user.userId,
        isGuest: false,
        time: this.now(),
      };
      if (image) {
        msg.imageData = image.dataUrl;
        msg.imageMime = image.mimeType;
      } else {
        msg.text = text;
      }
      if (this.saveMessage) {
        const saved = storedChatMessage(await this.saveMessage(user.userId, msg));
        if (!saved) throw Object.assign(new Error('聊天记录保存失败'), { statusCode:503 });
        msg = saved;
      }
      this.broadcast('message', msg);
      sendJson(res, 200, { ok: true, id: msg.id });
      return true;
    }

    if (pathname === '/api/chat/history' && req.method === 'GET') {
      const before = String(urlObj.searchParams.get('before') || '');
      if (before && (!/^\d{1,20}$/.test(before) || before === '0')) {
        throw Object.assign(new Error('聊天记录游标不正确'), { statusCode:400 });
      }
      const requestedLimit = Number.parseInt(urlObj.searchParams.get('limit') || '', 10);
      const limit = Number.isInteger(requestedLimit)
        ? Math.max(1, Math.min(MAX_HISTORY_LIMIT, requestedLimit))
        : DEFAULT_HISTORY_LIMIT;
      const history = this.listMessages
        ? await this.listMessages({
          beforeId:before || null,
          since:before ? null : shanghaiYesterdayStart(this.now()),
          limit,
        })
        : { messages:[], nextCursor:null, hasMore:false };
      sendJson(res, 200, {
        messages:(history.messages || []).map(storedChatMessage).filter(Boolean),
        nextCursor:history.nextCursor || null,
        hasMore:history.hasMore === true,
        online:this.onlineCount(),
        persisted:Boolean(this.listMessages),
      });
      return true;
    }

    if (pathname === '/api/chat/online-users' && req.method === 'GET') {
      if (!user.isAdmin) {
        sendJson(res, 403, { error:'仅管理员可以查看在线用户' });
        return true;
      }
      sendJson(res, 200, { users:this.onlineUsers(), online:this.onlineCount() });
      return true;
    }

    sendJson(res, 404, { error: 'Not Found' });
    return true;
  }

  close() {
    for (const client of [...this.clients.values()]) {
      try { client.res.end(); } catch (_) {}
      client.cleanup();
    }
    this.clients.clear();
    this.messageRates.clear();
    this.imageRates.clear();
  }
}

function createChatService(options) {
  return new ChatService(options);
}

module.exports = {
  ChatService,
  createChatService,
  chatUser,
  parseChatImage,
  shanghaiYesterdayStart,
  storedChatMessage,
  MAX_IMAGE_BYTES,
};
