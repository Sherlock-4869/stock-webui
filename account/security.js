'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 64;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_AVATAR_BYTES = 160 * 1024;
const AVATAR_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONFIG_KEYS = Object.freeze([
  'watchlist_v1',
  'watchlist_groups_v1',
  'watchlist_active_group_v1',
  'fund_watchlist_v1',
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

function validImageSignature(mimeType, buffer) {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function validateAvatarData(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !AVATAR_IMAGE_TYPES.has(match[1])) {
    throw Object.assign(new Error('头像仅支持 JPEG、PNG 或 WebP 图片'), { statusCode:400 });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) {
    throw Object.assign(new Error('头像为空或超过 160KB 限制'), { statusCode:413 });
  }
  if (buffer.toString('base64') !== match[2] || !validImageSignature(match[1], buffer)) {
    throw Object.assign(new Error('头像内容或格式不正确'), { statusCode:400 });
  }
  return `data:${match[1]};base64,${match[2]}`;
}

function safeAvatarUrl(value) {
  const avatarUrl = String(value || '');
  if (/^https?:\/\//i.test(avatarUrl) || /^\/(?!\/)/.test(avatarUrl)) return avatarUrl;
  try { return validateAvatarData(avatarUrl); } catch (_) { return null; }
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
  MAX_AVATAR_BYTES,
  validateAvatarData,
  safeAvatarUrl,
  sanitizePageConfig,
  randomToken,
  tokenHash,
};
