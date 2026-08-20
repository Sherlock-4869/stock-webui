'use strict';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeSinaNewsUrl(value) {
  try {
    const url = new URL(String(value || '').replace(/^http:/i, 'https:'));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'sina.com.cn' || host.endsWith('.sina.com.cn') || host === 'sina.cn' || host.endsWith('.sina.cn'))) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function announcementKind(title, columns) {
  const columnNames = (Array.isArray(columns) ? columns : []).map(item => item?.column_name).filter(Boolean).join(' ');
  const text = `${columnNames} ${title}`;
  if (/年度报告|半年度报告|季度报告|年报|中报|季报/.test(text)) return '定期报告';
  if (/业绩预告/.test(text)) return '业绩预告';
  if (/业绩快报/.test(text)) return '业绩快报';
  if (/分红|利润分配|权益分派/.test(text)) return '分红派息';
  if (/回购/.test(text)) return '股份回购';
  if (/增持|减持|持股变动/.test(text)) return '持股变动';
  if (/并购|重组|收购|重大资产/.test(text)) return '并购重组';
  if (/风险|立案|处罚|问询|警示|退市/.test(text)) return '风险提示';
  return columnNames.split(' ')[0] || '公司公告';
}

function normalizeAnnouncementPayload(payload, symbol) {
  if (!payload || Number(payload.success) !== 1 || !Array.isArray(payload.data?.list)) throw new Error('Announcement payload is invalid');
  const code = String(symbol || '').slice(2);
  const prefix = String(symbol || '').startsWith('sh') ? 'H2' : 'H3';
  const seen = new Set();
  const announcements = [];
  for (const row of payload.data.list) {
    const artCode = String(row?.art_code || '');
    const security = (Array.isArray(row?.codes) ? row.codes : []).find(item => String(item?.stock_code) === code);
    if (!/^AN\d{18}$/.test(artCode) || !security || seen.has(artCode)) continue;
    const rawTitle = decodeHtml(row.title_ch || row.title);
    const title = rawTitle.replace(new RegExp(`^${String(security.short_name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:：]`), '').trim();
    if (!title) continue;
    seen.add(artCode);
    const kind = announcementKind(title, row.columns);
    announcements.push({
      id:artCode,
      title,
      kind,
      publishedAt:String(row.display_time || row.notice_date || '').slice(0, 19),
      url:`https://np-snotice.eastmoney.com/pdf/${prefix}_${artCode}_1.pdf`,
      source:'东方财富公开公告页',
      isReport:kind === '定期报告',
      important:/风险|立案|处罚|问询|警示|退市|重大|回购|分红|增持|减持|并购|重组|业绩预告/.test(`${kind} ${title}`),
    });
    if (announcements.length >= 100) break;
  }
  return announcements;
}

function normalizeFinancialPayload(payload, symbol) {
  if (!payload?.result || !Array.isArray(payload.result.data)) throw new Error('Financial payload is invalid');
  const secuCode = `${String(symbol || '').slice(2)}.${String(symbol || '').startsWith('sh') ? 'SH' : 'SZ'}`;
  const periods = [];
  const seen = new Set();
  for (const row of payload.result.data) {
    if (String(row?.SECUCODE || '').toUpperCase() !== secuCode || seen.has(String(row.REPORT_DATE))) continue;
    const reportDate = String(row.REPORT_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;
    seen.add(String(row.REPORT_DATE));
    periods.push({
      reportDate,
      reportName:decodeHtml(row.REPORT_DATE_NAME) || reportDate,
      noticeDate:String(row.NOTICE_DATE || '').slice(0, 10),
      revenue:numberOrNull(row.TOTALOPERATEREVE),
      netProfit:numberOrNull(row.PARENTNETPROFIT),
      revenueGrowth:numberOrNull(row.TOTALOPERATEREVETZ),
      netProfitGrowth:numberOrNull(row.PARENTNETPROFITTZ),
      eps:numberOrNull(row.EPSJB),
      bps:numberOrNull(row.BPS),
      operatingCashFlowPerShare:numberOrNull(row.MGJYXJJE),
      roe:numberOrNull(row.ROEJQ),
      grossMargin:numberOrNull(row.XSMLL),
    });
    if (periods.length >= 12) break;
  }
  return periods;
}

function newsKind(title, url) {
  if (/vReport_Show|研报|评级|券商/.test(`${url} ${title}`)) return '研报观点';
  if (/公告|年报|季报|中报|业绩/.test(title)) return '财报动态';
  return '公司新闻';
}

function parseSinaStockNews(source, limit = 24) {
  const section = String(source || '').match(/<div[^>]+class=["']datelist["'][^>]*>[\s\S]*?<\/div>/i)?.[0] || '';
  const pattern = /(\d{4}-\d{2}-\d{2})&nbsp;(\d{2}:\d{2})[\s\S]{0,120}?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const rows = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(section)) && rows.length < limit) {
    const url = safeSinaNewsUrl(match[3]);
    const title = decodeHtml(match[4]);
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (!url || !title || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id:`${match[1]}T${match[2]}:${rows.length}`,
      title,
      kind:newsKind(title, url),
      publishedAt:`${match[1]} ${match[2]}:00`,
      url,
      source:'新浪财经公开资讯',
    });
  }
  return rows;
}

module.exports = {
  normalizeAnnouncementPayload,
  normalizeFinancialPayload,
  parseSinaStockNews,
  safeSinaNewsUrl,
};
