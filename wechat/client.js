'use strict';

const https = require('https');

const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);

class WeChatApiError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'WeChatApiError';
    this.errcode = Number(response?.errcode ?? -1);
    this.response = response;
  }
}

function requestJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(url, {
      method,
      timeout: 10000,
      headers: payload ? {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
      } : undefined,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); }
        catch (_) { reject(new Error(`WeChat returned invalid JSON (HTTP ${response.statusCode})`)); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new WeChatApiError(`WeChat HTTP ${response.statusCode}`, data));
          return;
        }
        resolve(data);
      });
    });
    request.on('timeout', () => request.destroy(new Error('WeChat request timeout')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

class WeChatClient {
  constructor(config) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenRequest = null;
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.token && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) return this.token;
    if (!forceRefresh && this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const data = await requestJson('POST', 'https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: this.appId, secret: this.appSecret, force_refresh: forceRefresh,
      });
      if (!data.access_token) throw new WeChatApiError(`Failed to obtain access_token: ${data.errmsg || 'unknown error'}`, data);
      this.token = data.access_token;
      this.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
      return this.token;
    })();
    try { return await this.tokenRequest; }
    finally { this.tokenRequest = null; }
  }

  async call(method, pathname, body, retryToken = true) {
    const token = await this.getAccessToken(false);
    const separator = pathname.includes('?') ? '&' : '?';
    const data = await requestJson(method, `https://api.weixin.qq.com${pathname}${separator}access_token=${encodeURIComponent(token)}`, body);
    if (Number(data.errcode || 0) === 0) return data;
    if (retryToken && TOKEN_ERROR_CODES.has(Number(data.errcode))) {
      await this.getAccessToken(true);
      return this.call(method, pathname, body, false);
    }
    throw new WeChatApiError(`WeChat API error ${data.errcode}: ${data.errmsg || 'unknown error'}`, data);
  }

  sendText(openid, content) {
    return this.call('POST', '/cgi-bin/message/custom/send', {
      touser: openid,
      msgtype: 'text',
      text: { content },
    });
  }

  async listFollowers() {
    const openids = [];
    let nextOpenid = '';
    const seenCursors = new Set();
    do {
      const query = nextOpenid ? `?next_openid=${encodeURIComponent(nextOpenid)}` : '';
      const data = await this.call('GET', `/cgi-bin/user/get${query}`, null);
      openids.push(...(data.data?.openid || []));
      nextOpenid = data.next_openid || '';
      if (!data.count) break;
      if (nextOpenid && seenCursors.has(nextOpenid)) throw new Error('WeChat follower pagination returned a repeated cursor');
      if (nextOpenid) seenCursors.add(nextOpenid);
    } while (nextOpenid);
    return [...new Set(openids)];
  }
}

module.exports = { WeChatClient, WeChatApiError, requestJson };
