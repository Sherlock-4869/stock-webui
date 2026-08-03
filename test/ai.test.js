'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryAccountDatabase, SCHEMA_STATEMENTS } = require('../account/database');
const { AccountService } = require('../account/service');
const { tokenHash } = require('../account/security');
const { AiService, encryptCredential, decryptCredential, loadAiConfig, agentPayloadSignature } = require('../ai/service');

async function aiRequest(service, aiService, pathname, { method = 'GET', body, cookie } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = method; req.url = pathname;
  req.headers = { host:'stock.test', origin:'http://stock.test', ...(cookie ? { cookie } : {}) };
  req.socket = { remoteAddress:'127.0.0.1', encrypted:false };
  const response = {
    status:200, headers:{}, headersSent:false, writableEnded:false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data = '') { this.body = String(data); this.writableEnded = true; },
  };
  await aiService.handleRoute(req, response, new URL(pathname, 'http://stock.test'));
  return { response, payload:response.body ? JSON.parse(response.body) : {} };
}

async function aiSession(database, user) {
  const token = crypto.randomBytes(24).toString('hex');
  await database.createSession({ userId:user.id, tokenHash:tokenHash(token), expiresAt:new Date(Date.now() + 60_000) });
  return `stock_session=${token}`;
}

test('AI model credentials are encrypted at rest and request signatures bind the body', () => {
  const encodedKey = crypto.randomBytes(32).toString('base64');
  const config = loadAiConfig({ STOCK_AI_CREDENTIAL_ENCRYPTION_KEY:encodedKey });
  const ciphertext = encryptCredential('sk-test-secret', config);
  assert.notEqual(ciphertext, 'sk-test-secret');
  assert.equal(decryptCredential(ciphertext, config), 'sk-test-secret');
  const body = Buffer.from('{"message":"分析 sh600519"}');
  assert.notEqual(agentPayloadSignature('internal-secret', '123', body), agentPayloadSignature('internal-secret', '123', Buffer.from('{}')));
});

test('AI conversation and message reads remain scoped to the owning account', async () => {
  const database = new MemoryAccountDatabase();
  const first = await database.createPasswordUser({ username:'first-user', passwordHash:'hash', displayName:'第一位' });
  const second = await database.createPasswordUser({ username:'second-user', passwordHash:'hash', displayName:'第二位' });
  const conversation = await database.createAiConversation(first.id, { id:crypto.randomUUID(), title:'第一位的问股' });
  await database.createAiMessage(conversation.id, { role:'user', content:'请分析 sh600519' });
  assert.equal((await database.listAiConversations(first.id)).length, 1);
  assert.equal((await database.listAiConversations(second.id)).length, 0);
  assert.equal(await database.getAiConversation(second.id, conversation.id), null);
  assert.deepEqual(await database.listAiMessages(second.id, conversation.id), []);
  assert.equal(await database.deleteAiConversation(second.id, conversation.id), false);
});

test('AI routes require server sessions, enforce per-user grants and scope conversation URLs', async t => {
  const accountService = new AccountService({ env:{ STOCK_ACCOUNT_ENABLED:'true', STOCK_ACCOUNT_DRIVER:'memory' } });
  await accountService.start(); t.after(() => accountService.close());
  const database = accountService.database;
  const admin = await database.createPasswordUser({ username:'ai-admin', passwordHash:'hash', displayName:'管理员' });
  const user = await database.createPasswordUser({ username:'ai-user', passwordHash:'hash', displayName:'普通用户' });
  const other = await database.createPasswordUser({ username:'ai-other', passwordHash:'hash', displayName:'另一位用户' });
  database.users.get(admin.id).is_admin = 1;
  const key = crypto.randomBytes(32).toString('base64');
  const aiService = new AiService({ accountService, config:loadAiConfig({
    STOCK_AI_ENABLED:'true', STOCK_AI_AGENT_INTERNAL_TOKEN:'internal-test-token', STOCK_AI_CREDENTIAL_ENCRYPTION_KEY:key,
  }) });
  const adminCookie = await aiSession(database, admin);
  const userCookie = await aiSession(database, user);
  const otherCookie = await aiSession(database, other);

  let result = await aiRequest(accountService, aiService, '/api/ai/access', { cookie:userCookie });
  assert.equal(result.payload.canUse, false);
  result = await aiRequest(accountService, aiService, '/api/ai/conversations', { method:'POST', body:{}, cookie:userCookie });
  assert.equal(result.response.status, 403);

  result = await aiRequest(accountService, aiService, '/api/admin/ai/users', { cookie:userCookie });
  assert.equal(result.response.status, 403);
  result = await aiRequest(accountService, aiService, '/api/admin/ai/users', { cookie:adminCookie });
  assert.equal(result.response.status, 200);
  const listedUser = result.payload.users.find(item => item.id === String(user.id));
  assert.equal(listedUser.isGranted, false);
  assert.equal(Object.hasOwn(listedUser, 'passwordHash'), false);

  result = await aiRequest(accountService, aiService, `/api/admin/ai/users/${user.id}/permission`, { method:'PUT', body:{ canUse:true }, cookie:adminCookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.isGranted, true);
  result = await aiRequest(accountService, aiService, '/api/ai/access', { cookie:userCookie });
  assert.equal(result.payload.isPublic, false);
  assert.equal(result.payload.isGranted, true);
  assert.equal(result.payload.canUse, true);
  result = await aiRequest(accountService, aiService, '/api/ai/access', { cookie:otherCookie });
  assert.equal(result.payload.canUse, false);

  result = await aiRequest(accountService, aiService, '/api/admin/ai/models', { method:'POST', body:{ name:'测试模型', modelName:'gpt-test', baseUrl:'https://example.test/v1', apiKey:'secret-key', isActive:true }, cookie:adminCookie });
  assert.equal(result.response.status, 201);
  assert.equal(Object.hasOwn(result.payload.model, 'apiKey'), false);

  result = await aiRequest(accountService, aiService, '/api/ai/conversations', { method:'POST', body:{ title:'我的问股' }, cookie:userCookie });
  assert.equal(result.response.status, 201);
  const conversationId = result.payload.conversation.id;
  result = await aiRequest(accountService, aiService, `/api/ai/conversations/${conversationId}/messages`, { cookie:otherCookie });
  assert.equal(result.response.status, 403);

  result = await aiRequest(accountService, aiService, '/api/admin/ai/settings', { method:'PUT', body:{ isPublic:true }, cookie:adminCookie });
  assert.equal(result.response.status, 200);
  result = await aiRequest(accountService, aiService, `/api/ai/conversations/${conversationId}/messages`, { cookie:otherCookie });
  assert.equal(result.response.status, 404);

  result = await aiRequest(accountService, aiService, '/api/admin/ai/settings', { method:'PUT', body:{ isPublic:false }, cookie:adminCookie });
  assert.equal(result.response.status, 200);

  result = await aiRequest(accountService, aiService, `/api/admin/ai/users/${user.id}/permission`, { method:'PUT', body:{ canUse:false }, cookie:adminCookie });
  assert.equal(result.response.status, 200);
  result = await aiRequest(accountService, aiService, '/api/ai/access', { cookie:userCookie });
  assert.equal(result.payload.canUse, false);

  result = await aiRequest(accountService, aiService, '/api/admin/ai/settings', { method:'PUT', body:{ isPublic:true }, cookie:adminCookie });
  assert.equal(result.response.status, 200);
  result = await aiRequest(accountService, aiService, '/api/ai/access', { cookie:otherCookie });
  assert.equal(result.payload.canUse, true);
});

test('AI persistence schema stays aligned across runtime, canonical SQL and operator documentation', () => {
  const runtimeSchema = SCHEMA_STATEMENTS.join('\n');
  const canonicalSchema = fs.readFileSync(path.join(__dirname, '..', 'database', 'account_schema.sql'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const schema of [runtimeSchema, canonicalSchema, readme]) {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_feature_settings/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_user_permissions/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_model_configs/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_conversations/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_messages/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_usage_records/);
  }
});
