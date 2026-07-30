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

test('notes CRUD is persisted and isolated by account', async t => {
  const app = await startTestService();
  t.after(app.close);

  const first = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST',
    body:{ username:'notes_owner', password:'password-123', displayName:'笔记用户' },
  });
  const firstCookie = cookieFrom(first);
  const second = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST',
    body:{ username:'notes_other', password:'password-123', displayName:'其他用户' },
  });
  const secondCookie = cookieFrom(second);

  const created = await jsonRequest(app.service, '/api/notes', {
    method:'POST', cookie:firstCookie,
    body:{ title:'安全笔记', content:'# 内容\n<img src=x onerror=alert(1)>' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.note.title, '安全笔记');
  const noteId = created.payload.note.id;

  const imported = await jsonRequest(app.service, '/api/notes/import', {
    method:'POST', cookie:firstCookie,
    body:{ title:'导入文档', content:'# 导入内容\n<script>alert(1)</script>' },
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.note.content, '# 导入内容\n<script>alert(1)</script>');

  const firstList = await jsonRequest(app.service, '/api/notes', { cookie:firstCookie });
  assert.equal(firstList.payload.notes.length, 2);
  const secondList = await jsonRequest(app.service, '/api/notes', { cookie:secondCookie });
  assert.deepEqual(secondList.payload.notes, []);

  const forbiddenRead = await jsonRequest(app.service, `/api/notes/${noteId}`, { cookie:secondCookie });
  assert.equal(forbiddenRead.response.status, 404);
  const forbiddenUpdate = await jsonRequest(app.service, `/api/notes/${noteId}`, {
    method:'PUT', cookie:secondCookie, body:{ title:'越权修改' },
  });
  assert.equal(forbiddenUpdate.response.status, 404);
  const forbiddenDelete = await jsonRequest(app.service, `/api/notes/${noteId}`, {
    method:'DELETE', cookie:secondCookie, body:{},
  });
  assert.equal(forbiddenDelete.response.status, 404);

  const updated = await jsonRequest(app.service, `/api/notes/${noteId}`, {
    method:'PUT', cookie:firstCookie, body:{ title:'已更新', content:'新的内容' },
  });
  assert.equal(updated.payload.note.title, '已更新');
  const removed = await jsonRequest(app.service, `/api/notes/${noteId}`, {
    method:'DELETE', cookie:firstCookie, body:{},
  });
  assert.equal(removed.payload.deleted, true);
});

test('note folders classify notes without crossing accounts or deleting content', async t => {
  const app = await startTestService();
  t.after(app.close);

  const owner = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST', body:{ username:'folder_owner', password:'password-123', displayName:'分类用户' },
  });
  const ownerCookie = cookieFrom(owner);
  const other = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST', body:{ username:'folder_other', password:'password-123', displayName:'其他分类用户' },
  });
  const otherCookie = cookieFrom(other);

  const createdFolder = await jsonRequest(app.service, '/api/note-folders', {
    method:'POST', cookie:ownerCookie, body:{ name:'研究资料' },
  });
  assert.equal(createdFolder.response.status, 201);
  assert.equal(createdFolder.payload.folder.name, '研究资料');
  const folderId = createdFolder.payload.folder.id;

  const duplicate = await jsonRequest(app.service, '/api/note-folders', {
    method:'POST', cookie:ownerCookie, body:{ name:'研究资料' },
  });
  assert.equal(duplicate.response.status, 409);

  const otherFolder = await jsonRequest(app.service, '/api/note-folders', {
    method:'POST', cookie:otherCookie, body:{ name:'研究资料' },
  });
  assert.equal(otherFolder.response.status, 201);

  const forbiddenRead = await jsonRequest(app.service, `/api/note-folders/${folderId}`, { cookie:otherCookie });
  assert.equal(forbiddenRead.response.status, 404);
  const forbiddenRename = await jsonRequest(app.service, `/api/note-folders/${folderId}`, {
    method:'PUT', cookie:otherCookie, body:{ name:'越权分类' },
  });
  assert.equal(forbiddenRename.response.status, 404);
  const forbiddenDelete = await jsonRequest(app.service, `/api/note-folders/${folderId}`, {
    method:'DELETE', cookie:otherCookie, body:{},
  });
  assert.equal(forbiddenDelete.response.status, 404);

  const note = await jsonRequest(app.service, '/api/notes', {
    method:'POST', cookie:ownerCookie,
    body:{ title:'归档笔记', content:'# 不应丢失', folderId },
  });
  assert.equal(note.response.status, 201);
  assert.equal(String(note.payload.note.folder_id), String(folderId));

  const crossAccountMove = await jsonRequest(app.service, `/api/notes/${note.payload.note.id}`, {
    method:'PUT', cookie:ownerCookie, body:{ folderId:otherFolder.payload.folder.id },
  });
  assert.equal(crossAccountMove.response.status, 400);

  const folderList = await jsonRequest(app.service, '/api/note-folders', { cookie:ownerCookie });
  assert.equal(folderList.payload.folders.length, 1);
  assert.equal(Number(folderList.payload.folders[0].note_count), 1);

  const renamed = await jsonRequest(app.service, `/api/note-folders/${folderId}`, {
    method:'PUT', cookie:ownerCookie, body:{ name:'长期研究' },
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.payload.folder.name, '长期研究');

  const deleted = await jsonRequest(app.service, `/api/note-folders/${folderId}`, {
    method:'DELETE', cookie:ownerCookie, body:{},
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.notesMovedToUnfiled, true);

  const preservedNote = await jsonRequest(app.service, `/api/notes/${note.payload.note.id}`, { cookie:ownerCookie });
  assert.equal(preservedNote.response.status, 200);
  assert.equal(preservedNote.payload.note.content, '# 不应丢失');
  assert.equal(preservedNote.payload.note.folder_id, null);
  const emptyFolders = await jsonRequest(app.service, '/api/note-folders', { cookie:ownerCookie });
  assert.deepEqual(emptyFolders.payload.folders, []);
});
