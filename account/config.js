'use strict';

function booleanValue(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integerValue(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function loadAccountConfig(env = process.env) {
  const enabled = booleanValue(env.STOCK_ACCOUNT_ENABLED, false);
  const driver = env.STOCK_ACCOUNT_DRIVER === 'memory' ? 'memory' : 'mysql';
  const wechat = {
    appId: env.STOCK_WECHAT_LOGIN_APP_ID || '',
    appSecret: env.STOCK_WECHAT_LOGIN_APP_SECRET || '',
    callbackUrl: env.STOCK_WECHAT_LOGIN_CALLBACK_URL || '',
  };
  wechat.enabled = Boolean(wechat.appId && wechat.appSecret && wechat.callbackUrl);

  const config = {
    enabled,
    driver,
    cookieName: 'stock_session',
    sessionDays: integerValue(env.STOCK_ACCOUNT_SESSION_DAYS, 30, 1, 365),
    wechat,
    database: {
      host: env.STOCK_DB_HOST || '',
      port: integerValue(env.STOCK_DB_PORT, 3306, 1, 65535),
      user: env.STOCK_DB_USER || '',
      password: env.STOCK_DB_PASSWORD || '',
      database: env.STOCK_DB_NAME || 'stock',
      connectionLimit: integerValue(env.STOCK_DB_CONNECTION_LIMIT, 5, 2, 50),
    },
  };

  config.missing = [];
  if (enabled && driver === 'mysql') {
    if (!config.database.host) config.missing.push('STOCK_DB_HOST');
    if (!config.database.user) config.missing.push('STOCK_DB_USER');
    if (!config.database.password) config.missing.push('STOCK_DB_PASSWORD');
  }
  return config;
}

module.exports = { loadAccountConfig };
