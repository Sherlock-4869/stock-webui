'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 64;
const MAX_CONFIG_BYTES = 256 * 1024;
const CONFIG_KEYS = Object.freeze([
  'watchlist_v1',
  'watchlist_groups_v1',
  'watchlist_active_group_v1',
  'stock_active_page_v1',
  'stock_anomaly_events_v1',
  'stock_theme_v1',
  'stock_optional_metrics_v1',
  'stock_list_colors_v1',
  'global_market_order_v1',
  'global_market_rows_v1',
  'stock_refresh_interval_v1',
]);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, SCRYPT_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN), r = Number(rawR), p = Number(rawP);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt, expected;
  try {
    salt = Buffer.from(rawSalt, 'base64url');
    expected = Buffer.from(rawHash, 'base64url');
  } catch (_) {
    return false;
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_LENGTH) return false;
  const actual = await scrypt(String(password), salt, expected.length, {
    N, r, p, maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9_.-]{3,31}$/.test(username)) {
    throw Object.assign(new Error('账号需为 4-32 位字母、数字、点、横线或下划线'), { statusCode: 400 });
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 128) {
    throw Object.assign(new Error('密码长度需为 8-128 位'), { statusCode: 400 });
  }
  return password;
}

function validateDisplayName(value, fallback) {
  const displayName = String(value || '').trim() || fallback;
  if (!displayName || displayName.length > 40) {
    throw Object.assign(new Error('显示名称不能为空且不能超过 40 个字符'), { statusCode: 400 });
  }
  return displayName;
}

function sanitizePageConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawValues = source.values && typeof source.values === 'object' && !Array.isArray(source.values)
    ? source.values
    : {};
  const values = {};
  for (const key of CONFIG_KEYS) {
    if (!(key in rawValues)) continue;
    if (typeof rawValues[key] !== 'string') {
      throw Object.assign(new Error('页面配置格式不正确'), { statusCode: 400 });
    }
    values[key] = rawValues[key];
  }
  const config = { version: 1, values };
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > MAX_CONFIG_BYTES) {
    throw Object.assign(new Error('页面配置超过 256KB 限制'), { statusCode: 413 });
  }
  return config;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

module.exports = {
  CONFIG_KEYS,
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validateUsername,
  validatePassword,
  validateDisplayName,
  sanitizePageConfig,
  randomToken,
  tokenHash,
};
