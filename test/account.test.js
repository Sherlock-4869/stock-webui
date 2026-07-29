'use strict';

const { Readable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountService } = require('../account/service');
const { hashPassword, verifyPassword, sanitizePageConfig } = require('../account/security');

async function startTestService() {
  const service = new AccountService({
    env: {
      STOCK_ACCOUNT_ENABLED: 'true',
      STOCK_ACCOUNT_DRIVER: 'memory',
      STOCK_ACCOUNT_SESSION_DAYS: '7',
    },
  });
  await service.start();
  return {
    service,
    close: async () => service.close(),
  };
}

async function jsonRequest(service, path, { method = 'GET', body, cookie } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = method;
  req.url = path;
  req.headers = { host:'stock.test', origin:'http://stock.test' };
  if (body !== undefined) req.headers['content-type'] = 'application/json';
  if (cookie) req.headers.cookie = cookie;
  req.socket = { remoteAddress:'127.0.0.1', encrypted:false };
  const response = {
    status: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      this.headersSent = true;
    },
    end(data = '') {
      this.body = String(data);
      this.writableEnded = true;
    },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
  };
  await service.handleRoute(req, response, new URL(path, 'http://stock.test'));
  return {
    response,
    payload: response.body ? JSON.parse(response.body) : {},
    setCookie: response.headers['set-cookie'],
  };
}

function cookieFrom(result) {
  return String(result.setCookie || '').split(';')[0];
}

test('scrypt password hashes are salted and verifiable', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
});

test('page config keeps only supported LocalStorage keys', () => {
  const config = sanitizePageConfig({ values:{
    watchlist_v1:'["sh600519"]',
    stock_theme_v1:'light',
    arbitrary_secret:'must-not-be-stored',
  } });
  assert.deepEqual(config, { version:1, values:{
    watchlist_v1:'["sh600519"]',
    stock_theme_v1:'light',
  } });
});

test('account HTTP flow persists config across logout and password login', async t => {
  const app = await startTestService();
  t.after(app.close);

  const registration = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST',
    body:{ username:'test_user', password:'password-123', displayName:'测试用户' },
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.payload.user.username, 'test_user');
  assert.equal(registration.payload.needsConfigDecision, true);
  let cookie = cookieFrom(registration);

  const decision = await jsonRequest(app.service, '/api/auth/preferences/decision', {
    method:'POST', cookie,
    body:{ importCurrent:true, config:{ values:{ watchlist_v1:'["sh600519","usAAPL"]', stock_theme_v1:'dark' } } },
  });
  assert.equal(decision.response.status, 200);
  assert.equal(decision.payload.imported, true);

  const me = await jsonRequest(app.service, '/api/auth/me', { cookie });
  assert.equal(me.payload.needsConfigDecision, false);
  assert.equal(me.payload.config.values.watchlist_v1, '["sh600519","usAAPL"]');

  const changed = await jsonRequest(app.service, '/api/auth/password', {
    method:'PUT', cookie,
    body:{ currentPassword:'password-123', newPassword:'password-456' },
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.payload.changed, true);

  const logout = await jsonRequest(app.service, '/api/auth/logout', { method:'POST', cookie, body:{} });
  assert.equal(logout.response.status, 200);

  const oldLogin = await jsonRequest(app.service, '/api/auth/login', {
    method:'POST', body:{ username:'test_user', password:'password-123' },
  });
  assert.equal(oldLogin.response.status, 401);

  const login = await jsonRequest(app.service, '/api/auth/login', {
    method:'POST', body:{ username:'test_user', password:'password-456' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.config.values.stock_theme_v1, 'dark');
  cookie = cookieFrom(login);

  const afterLogin = await jsonRequest(app.service, '/api/auth/me', { cookie });
  assert.equal(afterLogin.payload.user.displayName, '测试用户');
  assert.equal(afterLogin.payload.config.values.watchlist_v1, '["sh600519","usAAPL"]');
});
