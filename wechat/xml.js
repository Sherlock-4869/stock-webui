'use strict';

const XML_ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&',
};

function decodeXml(value) {
  return String(value || '').replace(/&(lt|gt|quot|apos|amp);/g, entity => XML_ENTITIES[entity]);
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseWechatXml(xml) {
  const result = {};
  const text = String(xml || '')
    .replace(/^\s*<xml[^>]*>/i, '')
    .replace(/<\/xml>\s*$/i, '');
  const pattern = /<([A-Za-z][A-Za-z0-9_]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match;
  while ((match = pattern.exec(text))) {
    result[match[1]] = decodeXml(match[2] != null ? match[2] : match[3].trim());
  }
  return result;
}

function textReplyXml(message, content) {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${String(message.FromUserName || '').replace(/\]\]>/g, '')}]]></ToUserName>`,
    `<FromUserName><![CDATA[${String(message.ToUserName || '').replace(/\]\]>/g, '')}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content>${escapeXml(content)}</Content>`,
    '</xml>',
  ].join('');
}

module.exports = { parseWechatXml, textReplyXml, escapeXml };
