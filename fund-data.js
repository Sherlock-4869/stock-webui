'use strict';

const FUND_RETURN_FIELDS = [
  'daily', 'week', 'month', 'threeMonths', 'sixMonths', 'year',
  'twoYears', 'threeYears', 'yearToDate', 'sinceInception',
];

function numberOrNull(value) {
  if (value === '' || value == null || value === '--') return null;
  const number = Number(String(value).replace(/[%亿元万份]/g, '').replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function extractJsValue(source, variableName) {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(source || '').match(new RegExp(`\\bvar\\s+${escapedName}\\s*=\\s*([^;]+)`));
  if (!match) return null;
  const raw = match[1].trim();
  try { return JSON.parse(raw); } catch (_) {}
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return numberOrNull(raw);
}

function latestSeriesSnapshot(value) {
  const categories = Array.isArray(value?.categories) ? value.categories : [];
  const lastIndex = categories.length - 1;
  if (lastIndex < 0) return null;
  const snapshot = { date:String(categories[lastIndex] || '') };
  for (const series of Array.isArray(value?.series) ? value.series : []) {
    const key = String(series?.name || '').trim();
    if (!key) continue;
    snapshot[key] = numberOrNull(series?.data?.[lastIndex]);
  }
  return snapshot;
}

function normalizeManager(manager) {
  const profitCategories = Array.isArray(manager?.profit?.categories) ? manager.profit.categories : [];
  const profitValues = Array.isArray(manager?.profit?.series?.[0]?.data)
    ? manager.profit.series[0].data.map(item => numberOrNull(item?.y)) : [];
  return {
    id:String(manager?.id || ''),
    name:String(manager?.name || ''),
    star:numberOrNull(manager?.star),
    workTime:String(manager?.workTime || ''),
    fundSize:String(manager?.fundSize || ''),
    score:numberOrNull(manager?.power?.avr),
    ability:Array.isArray(manager?.power?.categories) ? manager.power.categories.map((name, index) => ({
      name:String(name || ''), value:numberOrNull(manager?.power?.data?.[index]),
    })) : [],
    profit:profitCategories.map((name, index) => ({ name:String(name || ''), value:profitValues[index] ?? null })),
  };
}

function parseFundScript(source) {
  const netWorth = extractJsValue(source, 'Data_netWorthTrend');
  const accumulated = extractJsValue(source, 'Data_ACWorthTrend');
  const comparison = extractJsValue(source, 'Data_grandTotal');
  const managers = extractJsValue(source, 'Data_currentFundManager');
  const performance = extractJsValue(source, 'Data_performanceEvaluation');
  const scales = extractJsValue(source, 'Data_fluctuationScale');
  const positions = extractJsValue(source, 'Data_fundSharesPositions');
  const latestScaleIndex = Array.isArray(scales?.categories) ? scales.categories.length - 1 : -1;
  return {
    code:String(extractJsValue(source, 'fS_code') || ''),
    name:String(extractJsValue(source, 'fS_name') || ''),
    purchase:{
      sourceRate:numberOrNull(extractJsValue(source, 'fund_sourceRate')),
      currentRate:numberOrNull(extractJsValue(source, 'fund_Rate')),
      minimum:numberOrNull(extractJsValue(source, 'fund_minsg')),
    },
    returns:{
      month:numberOrNull(extractJsValue(source, 'syl_1y')),
      threeMonths:numberOrNull(extractJsValue(source, 'syl_3y')),
      sixMonths:numberOrNull(extractJsValue(source, 'syl_6y')),
      year:numberOrNull(extractJsValue(source, 'syl_1n')),
    },
    netWorth:Array.isArray(netWorth) ? netWorth.map(point => ({
      timestamp:numberOrNull(point?.x), value:numberOrNull(point?.y),
      dailyReturn:numberOrNull(point?.equityReturn), distribution:String(point?.unitMoney || ''),
    })).filter(point => point.timestamp != null && point.value != null) : [],
    accumulated:Array.isArray(accumulated) ? accumulated.map(point => ({
      timestamp:numberOrNull(point?.[0]), value:numberOrNull(point?.[1]),
    })).filter(point => point.timestamp != null && point.value != null) : [],
    comparison:Array.isArray(comparison) ? comparison.map(series => ({
      name:String(series?.name || ''),
      data:Array.isArray(series?.data) ? series.data.map(point => ({ timestamp:numberOrNull(point?.[0]), value:numberOrNull(point?.[1]) })).filter(point => point.timestamp != null && point.value != null) : [],
    })) : [],
    stockPosition:Array.isArray(positions) ? positions.map(point => ({ timestamp:numberOrNull(point?.[0]), value:numberOrNull(point?.[1]) })).filter(point => point.timestamp != null && point.value != null) : [],
    allocation:latestSeriesSnapshot(extractJsValue(source, 'Data_assetAllocation')),
    holderStructure:latestSeriesSnapshot(extractJsValue(source, 'Data_holderStructure')),
    subscription:latestSeriesSnapshot(extractJsValue(source, 'Data_buySedemption')),
    scale:latestScaleIndex >= 0 ? (() => {
      const scalePoint = scales?.series?.[latestScaleIndex] || scales?.series?.[0] || {};
      return {
      date:String(scales.categories[latestScaleIndex] || ''),
      value:numberOrNull(scalePoint.y ?? scales?.series?.[0]?.data?.[latestScaleIndex]),
      change:String(scalePoint.mom ?? ''),
      };
    })() : null,
    evaluation:performance ? {
      score:numberOrNull(performance.avr),
      items:Array.isArray(performance.categories) ? performance.categories.map((name, index) => ({
        name:String(name || ''), value:numberOrNull(performance?.data?.[index]),
      })) : [],
    } : null,
    managers:Array.isArray(managers) ? managers.map(normalizeManager).filter(manager => manager.name) : [],
  };
}

function parseFundRanking(source, type = 'all') {
  const text = String(source || '').replace(/^\uFEFF/, '');
  const dataMatch = text.match(/datas\s*:\s*(\[[\s\S]*?\])\s*,\s*allRecords\s*:/);
  if (!dataMatch) throw new Error('Fund ranking payload is invalid');
  let rows;
  try { rows = JSON.parse(dataMatch[1]); } catch (_) { throw new Error('Fund ranking rows are invalid'); }
  const meta = key => numberOrNull(text.match(new RegExp(`${key}\\s*:\\s*(\\d+)`))?.[1]);
  const data = rows.map(raw => {
    const fields = String(raw || '').split(',');
    if (!/^\d{6}$/.test(fields[0] || '')) return null;
    const returns = {};
    const values = [fields[6], fields[7], fields[8], fields[9], fields[10], fields[11], fields[12], fields[13], fields[14], fields[15]];
    FUND_RETURN_FIELDS.forEach((name, index) => { returns[name] = numberOrNull(values[index]); });
    return {
      code:fields[0], name:fields[1] || fields[0], pinyin:fields[2] || '', type,
      navDate:fields[3] || '', unitNav:numberOrNull(fields[4]), accumulatedNav:numberOrNull(fields[5]),
      returns, establishedAt:fields[16] || '', purchasable:fields[17] === '1',
      sourceRate:numberOrNull(fields[19]), currentRate:numberOrNull(fields[20]),
    };
  }).filter(Boolean);
  return {
    data,
    total:meta('allRecords') ?? data.length,
    counts:{ all:meta('allNum'), index:meta('zs_count'), stock:meta('gp_count'), mixed:meta('hh_count'), bond:meta('zq_count'), qdii:meta('qdii_count'), fof:meta('fof_count') },
  };
}

function parseFundSearch(payload) {
  const rows = Array.isArray(payload?.Datas) ? payload.Datas : [];
  return rows.flatMap(row => {
    const basic = row?.FundBaseInfo || {};
    const code = String(row?.CODE || basic.FCODE || '');
    if (!/^\d{6}$/.test(code)) return [];
    return [{
      code, name:String(row?.NAME || basic.SHORTNAME || code), pinyin:String(row?.JP || ''),
      type:String(basic.FTYPE || ''), company:String(basic.JJGS || ''), manager:String(basic.JJJL || ''),
      navDate:String(basic.FSRQ || ''), unitNav:numberOrNull(basic.DWJZ), purchasable:String(basic.ISBUY || '') === '1',
      minimum:numberOrNull(basic.MINSG),
    }];
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ').trim();
}

function symbolFromEastmoneyId(value) {
  const match = String(value || '').match(/^(0|1|116)\.(\d{5,6})$/);
  if (!match) return '';
  if (match[1] === '116') return `hk${match[2].padStart(5, '0')}`;
  return `${match[1] === '1' ? 'sh' : 'sz'}${match[2].padStart(6, '0')}`;
}

function parseFundHoldings(source) {
  const text = String(source || '');
  const date = decodeHtml(text.match(/截止至：[\s\S]{0,120}?<font[^>]*>([^<]+)<\/font>/i)?.[1] || '');
  const tbody = text.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] || '';
  const holdings = [];
  for (const match of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => decodeHtml(cell[1]));
    if (cells.length < 7 || !/^\d+$/.test(cells[0])) continue;
    const eastmoneyId = row.match(/unify\/r\/([0-9.]+)/i)?.[1] || '';
    holdings.push({
      rank:Number(cells[0]), code:cells[1], name:cells[2], symbol:symbolFromEastmoneyId(eastmoneyId),
      ratio:numberOrNull(cells[6]), shares:numberOrNull(cells[7]), marketValue:numberOrNull(cells[8]),
    });
  }
  return { date, data:holdings.slice(0, 20), totalRatio:holdings.reduce((sum, item) => sum + (item.ratio || 0), 0) };
}

function safeEastmoneyUrl(value) {
  try {
    const url = new URL(String(value || '').replace(/^http:/i, 'https:'));
    if (url.protocol !== 'https:' || !/(^|\.)eastmoney\.com$/i.test(url.hostname)) return '';
    return url.href;
  } catch (_) { return ''; }
}

function parseNewsList(section) {
  const rows = [];
  for (const match of String(section || '').matchAll(/<li[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)) {
    const title = decodeHtml(match[2].match(/class=["']newsTit["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || match[2]);
    const date = decodeHtml(match[2].match(/class=["']newsData["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const url = safeEastmoneyUrl(match[1]);
    if (title && url) rows.push({ title, date, url });
  }
  return rows.slice(0, 8);
}

function parseFundNews(source) {
  const text = String(source || '');
  const newsSection = text.match(/基金要闻 start -->([\s\S]*?)<!-- 基金要闻 end/)?.[1] || '';
  const announcementSection = text.match(/基金公告 start -->([\s\S]*?)<!-- 基金公告 end/)?.[1] || '';
  return { news:parseNewsList(newsSection), announcements:parseNewsList(announcementSection) };
}

module.exports = {
  extractJsValue,
  parseFundHoldings,
  parseFundNews,
  parseFundRanking,
  parseFundScript,
  parseFundSearch,
  safeEastmoneyUrl,
  symbolFromEastmoneyId,
};
