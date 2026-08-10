'use strict';

const { Readable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AccountService } = require('../account/service');
const {
  FUND_FLOW_HISTORY_CACHE_RETENTION_MS, MemoryAccountDatabase, SCHEMA_STATEMENTS, ensureSiteRecommendationVisibilitySchema, ensureAvatarSchema,
} = require('../account/database');
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

test('memory account cleanup removes stale fund flow history cache entries', async () => {
  const database = new MemoryAccountDatabase();
  await database.saveFundFlowHistoryCache('sh600519', {
    data:[{ date:'2026-07-01', mainNet:1 }], source:'test',
    fetchedAt:new Date(Date.now() - FUND_FLOW_HISTORY_CACHE_RETENTION_MS - 1000),
  });
  await database.saveFundFlowHistoryCache('sz000001', {
    data:[{ date:'2026-08-01', mainNet:2 }], source:'test', fetchedAt:new Date(),
  });
  await database.cleanup();
  assert.equal(await database.getFundFlowHistoryCache('sh600519'), null);
  assert.equal((await database.getFundFlowHistoryCache('sz000001')).data[0].mainNet, 2);
});

test('site recommendations start empty and remain publicly readable', async t => {
  const runtimeSchema = SCHEMA_STATEMENTS.join('\n');
  const canonicalSchema = fs.readFileSync(path.join(__dirname, '..', 'database', 'account_schema.sql'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const schema of [runtimeSchema, canonicalSchema, readme]) {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS site_recommendations/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS stock_fund_flow_history_cache/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS chat_messages/);
    assert.match(schema, /is_admin TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.match(schema, /is_admin_only TINYINT\(1\) NOT NULL DEFAULT 0/);
  }
  assert.doesNotMatch(runtimeSchema, /INSERT IGNORE INTO site_recommendations/);
  assert.doesNotMatch(canonicalSchema, /INSERT IGNORE INTO site_recommendations/);
  assert.doesNotMatch(readme, /INSERT IGNORE INTO site_recommendations/);
  const app = await startTestService();
  t.after(app.close);

  const result = await jsonRequest(app.service, '/api/site-recommendations');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.sites, []);

  const rejectedWrite = await jsonRequest(app.service, '/api/site-recommendations', {
    method:'POST', body:{ name:'不能通过公开接口写入' },
  });
  assert.equal(rejectedWrite.response.status, 405);
});

test('existing site recommendation tables receive the visibility migration', async () => {
  const queries = [];
  const connection = {
    async execute() { return [[], []]; },
    async query(sql) { queries.push(sql); return [[], []]; },
  };
  await ensureSiteRecommendationVisibilitySchema(connection, 'stock');
  assert.equal(queries.length, 2);
  assert.match(queries[0], /ADD COLUMN is_admin_only TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(queries[1], /ADD KEY idx_site_recommendations_visibility_sort/);
});

test('existing account tables receive the custom-avatar migration', async () => {
  const queries = [];
  const connection = {
    async execute() { return [[], []]; },
    async query(sql) { queries.push(sql); return [[], []]; },
  };
  await ensureAvatarSchema(connection, 'stock');
  assert.equal(queries.length, 1);
  assert.match(queries[0], /ADD COLUMN custom_avatar_data MEDIUMTEXT NULL/);
});

test('existing chat records expand the avatar snapshot column', async () => {
  const queries = [];
  let calls = 0;
  const connection = {
    async execute() {
      calls += 1;
      return calls === 1 ? [[{ exists:1 }], []] : [[{ DATA_TYPE:'varchar' }], []];
    },
    async query(sql) { queries.push(sql); return [[], []]; },
  };
  await ensureAvatarSchema(connection, 'stock');
  assert.deepEqual(queries, ['ALTER TABLE chat_messages MODIFY COLUMN avatar_url MEDIUMTEXT NULL']);
});

test('manual display names survive later WeChat profile refreshes', async () => {
  const database = new MemoryAccountDatabase();
  const created = await database.upsertWechatUser({
    providerUserId:'wechat-user', openid:'openid', unionid:null, displayName:'微信昵称', avatarUrl:'https://example.test/first.png', profile:{},
  });
  await database.updateProfile(created.id, { displayName:'自己设置的名字' });
  const refreshed = await database.upsertWechatUser({
    providerUserId:'wechat-user', openid:'openid', unionid:null, displayName:'新的微信昵称', avatarUrl:'https://example.test/second.png', profile:{},
  });
  assert.equal(refreshed.display_name, '自己设置的名字');
  assert.equal(refreshed.avatar_url, 'https://example.test/second.png');
});

test('only database-designated administrators can manage recommended sites', async t => {
  const app = await startTestService();
  t.after(app.close);

  const registration = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST',
    body:{ username:'site_admin', password:'password-123', displayName:'站点管理员' },
  });
  const cookie = cookieFrom(registration);
  assert.equal(registration.payload.user.isAdmin, false);

  const forbidden = await jsonRequest(app.service, '/api/admin/sites', { cookie });
  assert.equal(forbidden.response.status, 403);

  app.service.database.users.get(Number(registration.payload.user.id)).is_admin = 1;
  const me = await jsonRequest(app.service, '/api/auth/me', { cookie });
  assert.equal(me.payload.user.isAdmin, true);

  const ordinaryRegistration = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST',
    body:{ username:'site_reader', password:'password-123', displayName:'普通账号' },
  });
  const ordinaryCookie = cookieFrom(ordinaryRegistration);

  const created = await jsonRequest(app.service, '/api/admin/sites', {
    method:'POST', cookie,
    body:{
      name:'研究工具', url:'https://research.example.test/path', description:'测试站点',
      sortOrder:5, isActive:false, isAdminOnly:true,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.site.isActive, false);
  assert.equal(created.payload.site.isAdminOnly, true);
  const siteId = created.payload.site.id;

  const publicBeforeEnable = await jsonRequest(app.service, '/api/site-recommendations');
  assert.equal(publicBeforeEnable.payload.sites.some(site => site.id === siteId), false);

  const updated = await jsonRequest(app.service, `/api/admin/sites/${siteId}`, {
    method:'PUT', cookie,
    body:{
      name:'研究工具 Pro', url:'https://research.example.test/path', description:'已启用',
      sortOrder:1, isActive:true, isAdminOnly:true,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.site.name, '研究工具 Pro');
  assert.equal(updated.payload.site.isActive, true);
  assert.equal(updated.payload.site.isAdminOnly, true);

  const visitorSites = await jsonRequest(app.service, '/api/site-recommendations');
  assert.equal(visitorSites.payload.sites.some(site => site.id === siteId), false);
  const ordinarySites = await jsonRequest(app.service, '/api/site-recommendations', { cookie:ordinaryCookie });
  assert.equal(ordinarySites.payload.sites.some(site => site.id === siteId), false);
  const adminSites = await jsonRequest(app.service, '/api/site-recommendations', { cookie });
  assert.equal(adminSites.payload.sites.some(site => site.id === siteId), true);

  const madePublic = await jsonRequest(app.service, `/api/admin/sites/${siteId}`, {
    method:'PUT', cookie,
    body:{
      name:'研究工具 Pro', url:'https://research.example.test/path', description:'所有人可见',
      sortOrder:1, isActive:true, isAdminOnly:false,
    },
  });
  assert.equal(madePublic.payload.site.isAdminOnly, false);
  const publicAfterVisibilityChange = await jsonRequest(app.service, '/api/site-recommendations');
  assert.equal(publicAfterVisibilityChange.payload.sites.some(site => site.id === siteId), true);

  const removed = await jsonRequest(app.service, `/api/admin/sites/${siteId}`, {
    method:'DELETE', cookie, body:{},
  });
  assert.equal(removed.payload.deleted, true);
});

test('administrators can grant and revoke administrator roles without enabling self-escalation', async t => {
  const app = await startTestService();
  t.after(app.close);

  const owner = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST', body:{ username:'role_owner', password:'password-123', displayName:'初始管理员' },
  });
  const ownerCookie = cookieFrom(owner);
  app.service.database.users.get(Number(owner.payload.user.id)).is_admin = 1;

  const target = await jsonRequest(app.service, '/api/auth/register', {
    method:'POST', body:{ username:'role_target', password:'password-123', displayName:'待授权用户' },
  });
  const targetCookie = cookieFrom(target);

  const forbidden = await jsonRequest(app.service, `/api/admin/users/${owner.payload.user.id}/admin`, {
    method:'PUT', cookie:targetCookie, body:{ isAdmin:true },
  });
  assert.equal(forbidden.response.status, 403);

  const invalid = await jsonRequest(app.service, `/api/admin/users/${target.payload.user.id}/admin`, {
    method:'PUT', cookie:ownerCookie, body:{ isAdmin:'yes' },
  });
  assert.equal(invalid.response.status, 400);

  const selfChange = await jsonRequest(app.service, `/api/admin/users/${owner.payload.user.id}/admin`, {
    method:'PUT', cookie:ownerCookie, body:{ isAdmin:false },
  });
  assert.equal(selfChange.response.status, 400);

  const granted = await jsonRequest(app.service, `/api/admin/users/${target.payload.user.id}/admin`, {
    method:'PUT', cookie:ownerCookie, body:{ isAdmin:true },
  });
  assert.equal(granted.response.status, 200);
  assert.equal(granted.payload.user.isAdmin, true);

  const targetMe = await jsonRequest(app.service, '/api/auth/me', { cookie:targetCookie });
  assert.equal(targetMe.payload.user.isAdmin, true);
  const targetAdminAccess = await jsonRequest(app.service, '/api/admin/sites', { cookie:targetCookie });
  assert.equal(targetAdminAccess.response.status, 200);

  const revoked = await jsonRequest(app.service, `/api/admin/users/${target.payload.user.id}/admin`, {
    method:'PUT', cookie:ownerCookie, body:{ isAdmin:false },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.payload.user.isAdmin, false);

  const targetAfterRevoke = await jsonRequest(app.service, '/api/admin/sites', { cookie:targetCookie });
  assert.equal(targetAfterRevoke.response.status, 403);
  await assert.rejects(
    app.service.database.setUserAdmin({ userId:owner.payload.user.id, isAdmin:false }),
    error => error?.code === 'LAST_ACTIVE_ADMIN'
  );
  assert.equal((await app.service.database.findUserById(owner.payload.user.id)).is_admin, 1);
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

  const profileChanged = await jsonRequest(app.service, '/api/auth/profile', {
    method:'PUT', cookie, body:{ displayName:'新名称' },
  });
  assert.equal(profileChanged.response.status, 200);
  assert.equal(profileChanged.payload.user.displayName, '新名称');

  const invalidProfile = await jsonRequest(app.service, '/api/auth/profile', {
    method:'PUT', cookie, body:{ displayName:'   ' },
  });
  assert.equal(invalidProfile.response.status, 400);

  const avatarData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const avatarChanged = await jsonRequest(app.service, '/api/auth/avatar', {
    method:'PUT', cookie, body:{ avatarData },
  });
  assert.equal(avatarChanged.response.status, 200);
  assert.equal(avatarChanged.payload.changed, true);
  assert.equal(avatarChanged.payload.user.avatarUrl, avatarData);

  const avatarRemoved = await jsonRequest(app.service, '/api/auth/avatar', {
    method:'PUT', cookie, body:{ remove:true },
  });
  assert.equal(avatarRemoved.response.status, 200);
  assert.equal(avatarRemoved.payload.user.avatarUrl, null);

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
  assert.equal(afterLogin.payload.user.displayName, '新名称');
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
