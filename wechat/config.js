'use strict';

function booleanValue(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integerValue(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function loadWechatConfig(env = process.env) {
  const config = {
    enabled: booleanValue(env.STOCK_WECHAT_ENABLED, false),
    appId: env.STOCK_WECHAT_APP_ID || '',
    appSecret: env.STOCK_WECHAT_APP_SECRET || '',
    callbackToken: env.STOCK_WECHAT_CALLBACK_TOKEN || '',
    pageUrl: env.STOCK_WECHAT_PAGE_URL || 'https://stock.sherlock-holmes.cn/?page=ipo',
    adminKey: env.STOCK_WECHAT_ADMIN_KEY || '',
    autoEnable: booleanValue(env.STOCK_WECHAT_AUTO_ENABLE, true),
    timezone: env.STOCK_WECHAT_TIMEZONE || 'Asia/Shanghai',
    scheduleWeekday: integerValue(env.STOCK_WECHAT_SCHEDULE_WEEKDAY, 1, 0, 6),
    scheduleHour: integerValue(env.STOCK_WECHAT_SCHEDULE_HOUR, 9, 0, 23),
    scheduleMinute: integerValue(env.STOCK_WECHAT_SCHEDULE_MINUTE, 0, 0, 59),
    scheduleCatchup: booleanValue(env.STOCK_WECHAT_SCHEDULE_CATCHUP, true),
    database: {
      host: env.STOCK_DB_HOST || '',
      port: integerValue(env.STOCK_DB_PORT, 3306, 1, 65535),
      user: env.STOCK_DB_USER || '',
      password: env.STOCK_DB_PASSWORD || '',
      database: env.STOCK_DB_NAME || 'stock',
      // One connection holds the MySQL advisory lock while the pool performs
      // job queries, so the pool must contain at least two connections.
      connectionLimit: integerValue(env.STOCK_DB_CONNECTION_LIMIT, 5, 2, 50),
    },
  };

  config.missing = [];
  if (config.enabled) {
    if (!config.appId) config.missing.push('STOCK_WECHAT_APP_ID');
    if (!config.appSecret) config.missing.push('STOCK_WECHAT_APP_SECRET');
    if (!config.callbackToken) config.missing.push('STOCK_WECHAT_CALLBACK_TOKEN');
    if (!config.adminKey) config.missing.push('STOCK_WECHAT_ADMIN_KEY');
    if (!config.database.host) config.missing.push('STOCK_DB_HOST');
    if (!config.database.user) config.missing.push('STOCK_DB_USER');
    if (!config.database.password) config.missing.push('STOCK_DB_PASSWORD');
  }
  return config;
}

module.exports = { loadWechatConfig };
