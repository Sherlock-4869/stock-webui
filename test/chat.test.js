'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ChatService, parseChatImage, shanghaiYesterdayStart, MAX_IMAGE_BYTES,
} = require('../chat/chat');
const { MemoryAccountDatabase } = require('../account/database');

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const ONE_PIXEL_PNG_URL = `data:image/png;base64,${ONE_PIXEL_PNG}`;

function request(path, { method = 'GET', body, origin = 'http://stock.test' } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = path;
  req.headers = { host:'stock.test', origin };
  if (body !== undefined) req.headers['content-type'] = 'application/json';
  req.socket = { remoteAddress:'127.0.0.1' };
  return req;
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 200;
    this.headers = {};
    this.body = '';
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.writableLength = 0;
  }
  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.headersSent = true;
  }
  flushHeaders() {}
  write(data) { this.body += String(data); return true; }
  end(data = '') { this.body += String(data); this.writableEnded = true; this.emit('close'); }
}

const user = { id:7, username:'alice', display_name:'Alice', avatar_url:'https://example.test/a.png' };

async function call(service, path, options, sessionUser = user) {
  const req = request(path, options);
  const res = new MockResponse();
  await service.handleRoute(req, res, new URL(path, 'http://stock.test'), sessionUser);
  let payload = {};
  if (res.body && !res.body.startsWith('event:')) payload = JSON.parse(res.body);
  return { req, res, payload };
}

function sseEvent(body, eventName) {
  const block = String(body).split('\n\n').find(item => item.startsWith(`event: ${eventName}\n`));
  assert.ok(block, `expected ${eventName} SSE event`);
  const dataLine = block.split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(dataLine.slice(6));
}

test('chat endpoints require an authenticated account', async () => {
  const service = new ChatService();
  const history = await call(service, '/api/chat/history', {}, null);
  assert.equal(history.res.status, 401);
  assert.match(history.payload.error, /登录/);
  const send = await call(service, '/api/chat/send', { method:'POST', body:{ text:'hello' } }, null);
  assert.equal(send.res.status, 401);
});

test('chat messages use server session identity and reject cross-origin sends', async () => {
  const service = new ChatService({ now:() => 12345 });
  const stream = await call(service, '/api/chat/stream', {});
  stream.res.body = '';
  const sent = await call(service, '/api/chat/send', {
    method:'POST',
    body:{ text:'hello', userId:'999', displayName:'伪造身份', avatarUrl:'javascript:alert(1)' },
  });
  assert.equal(sent.res.status, 200);
  const message = sseEvent(stream.res.body, 'message');
  assert.equal(message.userId, '7');
  assert.equal(message.displayName, 'Alice');
  assert.equal(message.avatarUrl, 'https://example.test/a.png');
  assert.equal(message.isGuest, false);
  assert.equal(message.text, 'hello');

  await assert.rejects(
    () => call(service, '/api/chat/send', { method:'POST', body:{ text:'blocked' }, origin:'https://evil.test' }),
    error => error.statusCode === 403
  );
  service.close();
});

test('chat preserves a server-validated custom avatar', async () => {
  const avatarData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const service = new ChatService({ now:() => 12345 });
  const customUser = { ...user, avatar_url:null, custom_avatar_data:avatarData };
  const stream = await call(service, '/api/chat/stream', {}, customUser);
  assert.equal(sseEvent(stream.res.body, 'connected').avatarUrl, avatarData);
  stream.res.body = '';
  await call(service, '/api/chat/send', { method:'POST', body:{ text:'with avatar' } }, customUser);
  assert.equal(sseEvent(stream.res.body, 'message').avatarUrl, avatarData);
  service.close();
});

test('chat fallback without a persistence adapter does not retain messages', async () => {
  const service = new ChatService();
  const sent = await call(service, '/api/chat/send', { method:'POST', body:{ text:'temporary' } });
  assert.equal(sent.res.status, 200);
  const history = await call(service, '/api/chat/history', {});
  assert.deepEqual(history.payload.messages, []);
  assert.equal(history.payload.persisted, false);
  assert.equal(service.messages, undefined);
});

test('chat history initially loads from Shanghai yesterday and cursor-pages older records', async () => {
  const database = new MemoryAccountDatabase();
  const now = Date.parse('2026-07-30T04:00:00.000Z'); // 上海时间 7 月 30 日 12:00
  assert.equal(shanghaiYesterdayStart(now), '2026-07-29 00:00:00.000');

  const saveMessage = (userId, message) => database.createChatMessage(userId, message);
  const listMessages = options => database.listChatMessages(options);
  await saveMessage(7, {
    type:'text', text:'更早记录', displayName:'Alice', avatarUrl:null,
    time:Date.parse('2026-07-28T15:59:00.000Z'),
  });
  await saveMessage(7, {
    type:'text', text:'昨天记录', displayName:'Alice', avatarUrl:null,
    time:Date.parse('2026-07-28T16:00:00.000Z'),
  });
  await saveMessage(8, {
    type:'text', text:'今天记录', displayName:'Bob', avatarUrl:null,
    time:Date.parse('2026-07-30T03:00:00.000Z'),
  });

  const service = new ChatService({ now:() => now, saveMessage, listMessages });
  const initial = await call(service, '/api/chat/history?limit=10', {});
  assert.equal(initial.payload.persisted, true);
  assert.equal(initial.payload.historySince, '2026-07-29 00:00:00.000');
  assert.deepEqual(initial.payload.messages.map(message => message.text), ['昨天记录', '今天记录']);
  assert.equal(initial.payload.hasMore, true);
  assert.equal(initial.payload.nextCursor, '2');

  const older = await call(service, `/api/chat/history?before=${initial.payload.nextCursor}&limit=10`, {});
  assert.deepEqual(older.payload.messages.map(message => message.text), ['更早记录']);
  assert.equal(older.payload.historySince, null);
  assert.equal(older.payload.hasMore, false);
  assert.equal(older.payload.nextCursor, null);

  const sent = await call(service, '/api/chat/send', { method:'POST', body:{ text:'已持久化的新消息' } });
  assert.equal(sent.res.status, 200);
  assert.equal(sent.payload.id, '4');
  const reentered = await call(service, '/api/chat/history?limit=10', {});
  assert.deepEqual(
    reentered.payload.messages.map(message => message.text),
    ['昨天记录', '今天记录', '已持久化的新消息']
  );
});

test('chat history validates cursors and caps page size', async () => {
  let receivedOptions = null;
  const service = new ChatService({
    listMessages:async options => {
      receivedOptions = options;
      return { messages:[], nextCursor:null, hasMore:false };
    },
  });
  await assert.rejects(
    () => call(service, '/api/chat/history?before=not-a-number', {}),
    error => error.statusCode === 400
  );
  const result = await call(service, '/api/chat/history?before=123&limit=9999', {});
  assert.equal(result.res.status, 200);
  assert.deepEqual(receivedOptions, { beforeId:'123', since:null, limit:100 });
});

test('chat broadcasts validated temporary images and rejects unsafe image data', async () => {
  const service = new ChatService({ now:() => 12345 });
  const stream = await call(service, '/api/chat/stream', {});
  stream.res.body = '';
  const sent = await call(service, '/api/chat/send', {
    method:'POST',
    body:{ imageData:ONE_PIXEL_PNG_URL },
  });
  assert.equal(sent.res.status, 200);
  const message = sseEvent(stream.res.body, 'message');
  assert.equal(message.type, 'image');
  assert.equal(message.imageMime, 'image/png');
  assert.equal(message.imageData, ONE_PIXEL_PNG_URL);
  assert.equal(message.userId, '7');

  assert.throws(
    () => parseChatImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
    error => error.statusCode === 400
  );
  assert.throws(
    () => parseChatImage(`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`),
    error => error.statusCode === 400
  );
  assert.throws(
    () => parseChatImage(`data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`),
    error => error.statusCode === 413
  );
  service.close();
});

test('chat limits each account to three image messages per minute', async () => {
  const service = new ChatService({ now:() => 1000 });
  for (let index = 0; index < 3; index += 1) {
    const result = await call(service, '/api/chat/send', { method:'POST', body:{ imageData:ONE_PIXEL_PNG_URL } });
    assert.equal(result.res.status, 200);
  }
  await assert.rejects(
    () => call(service, '/api/chat/send', { method:'POST', body:{ imageData:ONE_PIXEL_PNG_URL } }),
    error => error.statusCode === 429
  );
});

test('chat applies message rate and per-account connection limits', async () => {
  let now = 1000;
  const service = new ChatService({ now:() => now });
  for (let index = 0; index < 8; index += 1) {
    const result = await call(service, '/api/chat/send', { method:'POST', body:{ text:`message ${index}` } });
    assert.equal(result.res.status, 200);
  }
  await assert.rejects(
    () => call(service, '/api/chat/send', { method:'POST', body:{ text:'too fast' } }),
    error => error.statusCode === 429
  );
  now += 10001;
  const afterWindow = await call(service, '/api/chat/send', { method:'POST', body:{ text:'allowed again' } });
  assert.equal(afterWindow.res.status, 200);

  const streams = [];
  for (let index = 0; index < 3; index += 1) {
    const stream = await call(service, '/api/chat/stream', {});
    assert.equal(stream.res.status, 200);
    streams.push(stream);
  }
  const excess = await call(service, '/api/chat/stream', {});
  assert.equal(excess.res.status, 429);
  assert.equal(service.onlineCount(), 1);

  streams[0].req.emit('close');
  streams[0].req.emit('error', new Error('duplicate cleanup'));
  assert.equal(service.clients.size, 2);
  service.close();
});

test('only administrators can list unique online chat accounts', async () => {
  let now = 1000;
  const service = new ChatService({ now:() => now++ });
  const aliceFirst = await call(service, '/api/chat/stream', {}, user);
  const aliceSecond = await call(service, '/api/chat/stream', {}, user);
  const bob = { id:8, username:'bob', display_name:'Bob', avatar_url:null };
  const bobStream = await call(service, '/api/chat/stream', {}, bob);

  const forbidden = await call(service, '/api/chat/online-users', {}, user);
  assert.equal(forbidden.res.status, 403);

  const admin = { id:99, username:'admin', display_name:'Admin', avatar_url:null, is_admin:1 };
  const result = await call(service, '/api/chat/online-users', {}, admin);
  assert.equal(result.res.status, 200);
  assert.equal(result.payload.online, 2);
  assert.deepEqual(result.payload.users.map(item => ({
    userId:item.userId, displayName:item.displayName, connections:item.connections,
  })), [
    { userId:'7', displayName:'Alice', connections:2 },
    { userId:'8', displayName:'Bob', connections:1 },
  ]);

  aliceFirst.req.emit('close');
  aliceSecond.req.emit('close');
  bobStream.req.emit('close');
  service.close();
});
