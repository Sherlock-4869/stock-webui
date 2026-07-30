'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatService, parseChatImage, MAX_IMAGE_BYTES } = require('../chat/chat');

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

test('chat never returns or retains messages from an earlier entry', async () => {
  const service = new ChatService();
  const sent = await call(service, '/api/chat/send', { method:'POST', body:{ text:'temporary' } });
  assert.equal(sent.res.status, 200);
  const history = await call(service, '/api/chat/history', {});
  assert.deepEqual(history.payload.messages, []);
  assert.equal(history.payload.ephemeral, true);
  assert.equal(service.messages, undefined);
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
