'use strict';

const crypto = require('crypto');
const { assertSameOrigin } = require('../account/service');

const MAX_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 500;
const MAX_REQUEST_BYTES = 4096;
const MAX_CONNECTIONS = 200;
const MAX_CONNECTIONS_PER_USER = 3;
const MESSAGE_RATE_LIMIT = 8;
const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
const MAX_SSE_BUFFER_BYTES = 64 * 1024;

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

class ChatService {
  constructor({ now = () => Date.now() } = {}) {
    this.messages = [];
    this.clients = new Map();
    this.messageRates = new Map();
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

  addMessage(msg) {
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES);
    this.broadcast('message', msg);
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
      const text = String(body.text || '').trim();
      if (!text || text.length > MAX_MESSAGE_LENGTH) {
        throw Object.assign(new Error('消息为空或超过限制'), { statusCode: 400 });
      }
      this.checkMessageRate(user.userId);
      const msg = {
        id: crypto.randomUUID(),
        text,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        userId: user.userId,
        isGuest: false,
        time: this.now(),
      };
      this.addMessage(msg);
      sendJson(res, 200, { ok: true, id: msg.id });
      return true;
    }

    if (pathname === '/api/chat/history' && req.method === 'GET') {
      sendJson(res, 200, { messages: this.messages.slice(-50), online: this.onlineCount() });
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
  }
}

function createChatService(options) {
  return new ChatService(options);
}

module.exports = { ChatService, createChatService, chatUser };
