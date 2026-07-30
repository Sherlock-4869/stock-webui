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
  };
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
  constructor({ now = () => Date.now() } = {}) {
    this.clients = new Map();
    this.messageRates = new Map();
    this.imageRates = new Map();
    this.now = now;
  }

  onlineCount() {
    return new Set([...this.clients.values()].map(client => client.user.userId)).size;
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

    this.clients.set(clientId, { res, user, cleanup });
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
      const msg = {
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
      this.broadcast('message', msg);
      sendJson(res, 200, { ok: true, id: msg.id });
      return true;
    }

    if (pathname === '/api/chat/history' && req.method === 'GET') {
      sendJson(res, 200, { messages: [], online: this.onlineCount(), ephemeral: true });
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

module.exports = { ChatService, createChatService, chatUser, parseChatImage, MAX_IMAGE_BYTES };
