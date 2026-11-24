'use strict';

const NEWS_CHANNELS = Object.freeze({
  all: { code: '102', label: '7×24 全球快讯' },
  focus: { code: '101', label: '焦点标红' },
  company: { code: '103', label: '上市公司' },
  global: { code: '105', label: '全球市场' },
});

const IMPORTANT_NEWS_KEYWORDS = Object.freeze([
  '央行', '降准', '降息', 'LPR', '美联储', '鲍威尔', '证监会', '国务院', '政治局',
  '财政部', '发改委', '非农', 'CPI', 'GDP', 'PMI', '社融', '印花税', '停牌', '立案',
  '回购', '增持', '业绩暴增', '涨停', '跌停', '熔断', '紧急', '重磅', '突破',
]);

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function dateOnly(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function stockSymbolFromCode(code, marketHint = '') {
  const raw = String(code || '').trim();
  if (!/^\d{6}$/.test(raw)) return '';
  const hint = String(marketHint || '').toUpperCase();
  if (hint.endsWith('.SH') || hint === 'SH' || hint === '1') return `sh${raw}`;
  if (hint.endsWith('.SZ') || hint === 'SZ' || hint === '0') {
    return /^[48]/.test(raw) ? '' : `sz${raw}`;
  }
  if (hint.endsWith('.BJ') || hint === 'BJ') return '';
  if (/^[56]/.test(raw)) return `sh${raw}`;
  if (/^[0123]/.test(raw)) return `sz${raw}`;
  return '';
}

function safeEastmoneyHttpsUrl(value) {
  try {
    const raw = String(value || '').trim().replace(/^http:\/\//i, 'https://');
    if (!raw) return '';
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !/(^|\.)eastmoney\.com$/i.test(parsed.hostname)) return '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMentionedCodes(text, stockList) {
  const codes = new Set();
  if (Array.isArray(stockList)) {
    for (const item of stockList) {
      const candidate = String(item?.code || item?.securityCode || item || '').match(/(\d{6})/)?.[1];
      if (candidate) codes.add(candidate);
    }
  }
  const matches = String(text || '').matchAll(/(?:[(（\s]|^)((?:60[0135]|688|00[0123]|30[01])\d{3})(?:[)）.\s]|$)/g);
  for (const match of matches) codes.add(match[1]);
  return [...codes].slice(0, 8);
}

function parseNewsFlashPayload(rawText, { channel = 'all', limit = 80 } = {}) {
  const stripped = String(rawText || '').replace(/^\s*var\s+ajaxResult\s*=\s*/, '').replace(/;\s*$/, '');
  let payload;
  try {
    payload = JSON.parse(stripped);
  } catch (_) {
    return [];
  }
  const list = Array.isArray(payload?.LivesList) ? payload.LivesList : [];
  const seen = new Set();
  const items = [];

  for (const row of list) {
    const id = String(row?.id || row?.newsid || '').trim();
    const title = stripTags(row?.title || row?.simtitle || '');
    const digest = stripTags(row?.digest || row?.simdigest || '');
    const content = digest || title;
    if (!title && !digest) continue;
    const dedupeKey = id || `${row?.showtime || ''}:${title || digest.slice(0, 40)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const url = safeEastmoneyHttpsUrl(row?.url_w || row?.url_m || '');
    const showTime = String(row?.showtime || row?.ordertime || '').trim();
    const combinedText = `${title} ${digest}`;
    const importantFlag = channel === 'focus'
      || String(row?.important || row?.is_important || '') === '1'
      || String(row?.color || '') === '1'
      || IMPORTANT_NEWS_KEYWORDS.some(keyword => combinedText.includes(keyword));
    const codes = extractMentionedCodes(combinedText, row?.stockList);
    const stocks = codes.map(code => ({
      code,
      symbol: stockSymbolFromCode(code),
    }));

    items.push({
      id: id || dedupeKey,
      channel,
      time: showTime,
      title: title || content.slice(0, 48),
      summary: content,
      url,
      important: importantFlag,
      stocks,
    });
    if (items.length >= limit) break;
  }

  return items;
}

function adjustWeekendToMonday(dateUtc) {
  const day = dateUtc.getUTCDay();
  if (day === 6) dateUtc.setUTCDate(dateUtc.getUTCDate() + 2);
  else if (day === 0) dateUtc.setUTCDate(dateUtc.getUTCDate() + 1);
  return dateUtc;
}

function adjustWeekendToFriday(dateUtc) {
  const day = dateUtc.getUTCDay();
  if (day === 6) dateUtc.setUTCDate(dateUtc.getUTCDate() - 1);
  else if (day === 0) dateUtc.setUTCDate(dateUtc.getUTCDate() - 2);
  return dateUtc;
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + offset + (nth - 1) * 7));
}

function isoDateUtc(dateUtc) {
  return dateUtc.toISOString().slice(0, 10);
}

function buildUpcomingMacroSchedule(startDateStr, days = 30) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDateStr || ''))) return [];
  const start = new Date(`${startDateStr}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + Math.max(1, Math.min(90, Number(days) || 30)));
  const startIso = isoDateUtc(start);
  const endIso = isoDateUtc(end);

  const events = [];
  const startMonth = start.getUTCFullYear() * 12 + start.getUTCMonth();
  const endMonth = end.getUTCFullYear() * 12 + end.getUTCMonth();

  for (let m = startMonth; m <= endMonth; m += 1) {
    const year = Math.floor(m / 12);
    const monthIndex = m % 12;
    const monthLabel = `${monthIndex + 1}月`;

    // 1. US Non-Farm Payrolls: First Friday of month
    const nfpDate = isoDateUtc(nthWeekdayOfMonth(year, monthIndex, 5, 1));
    events.push({
      date: nfpDate,
      time: '20:30',
      region: '美国',
      category: 'macro',
      importance: 'high',
      title: `美国非农就业人口与失业率报告（${monthLabel}披露）`,
      note: '影响美联储利率预期与全球风险资产定价',
    });

    // 2. China CPI & PPI release window (~10th of month, shifted off weekend)
    const cnCpiDate = isoDateUtc(adjustWeekendToMonday(new Date(Date.UTC(year, monthIndex, 10))));
    events.push({
      date: cnCpiDate,
      time: '09:30',
      region: '中国',
      category: 'macro',
      importance: 'high',
      title: `国家统计局公布 CPI / PPI 物价指数（${monthLabel}发布窗口）`,
      note: '观察内需修复斜率与工业品价格弹性',
    });

    // 3. US CPI release window (~13th of month, shifted off weekend)
    const usCpiDate = isoDateUtc(adjustWeekendToMonday(new Date(Date.UTC(year, monthIndex, 13))));
    events.push({
      date: usCpiDate,
      time: '20:30',
      region: '美国',
      category: 'macro',
      importance: 'high',
      title: `美国 CPI 通胀数据披露窗口（${monthLabel}）`,
      note: '核心通胀走势直接影响美债收益率与成长股估值',
    });

    // 4. China MLF / Macro Economy Activity (Retail, Industrial, FAI ~15th)
    const cnEconDate = isoDateUtc(adjustWeekendToMonday(new Date(Date.UTC(year, monthIndex, 15))));
    events.push({
      date: cnEconDate,
      time: '10:00',
      region: '中国',
      category: 'macro',
      importance: 'medium',
      title: `中国社零、规模以上工业增加值与固定资产投资（${monthLabel}窗口）`,
      note: '跟踪国内宏观总量景气度变化',
    });

    // 5. CFFEX Stock Index Futures Settlement: Third Friday of month
    const cffexDate = isoDateUtc(nthWeekdayOfMonth(year, monthIndex, 5, 3));
    events.push({
      date: cffexDate,
      time: '15:00',
      region: '中国',
      category: 'macro',
      importance: 'medium',
      title: `${monthLabel}中金所股指期货（IF/IH/IC/IM）合约交割日`,
      note: '留意当月合约移仓换月与基差收敛波动',
    });

    // 6. China LPR Quotation: 20th of month (postponed to Monday on weekend)
    const lprDate = isoDateUtc(adjustWeekendToMonday(new Date(Date.UTC(year, monthIndex, 20))));
    events.push({
      date: lprDate,
      time: '09:15',
      region: '中国',
      category: 'macro',
      importance: 'high',
      title: `${monthLabel}贷款市场报价利率（1年期 / 5年期以上 LPR）公布`,
      note: '观察货币政策宽信用与地产按揭利率动向',
    });

    // 7. China Official NBS Manufacturing PMI: Last day of month
    const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0));
    const pmiDate = isoDateUtc(adjustWeekendToFriday(lastDayOfMonth));
    events.push({
      date: pmiDate,
      time: '09:30',
      region: '中国',
      category: 'macro',
      importance: 'high',
      title: `${monthLabel}中国官方制造业与非制造业 PMI 景气指数`,
      note: '领先反映下月制造业订单与宏观景气荣枯线（50%）',
    });
  }

  return events
    .filter(item => item.date >= startIso && item.date <= endIso)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

function normalizeEarningsCalendarPayload(payload) {
  const rows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const code = String(row?.SECURITY_CODE || '').trim();
    const name = String(row?.SECURITY_NAME_ABBR || '').trim();
    const scheduledDate = dateOnly(row?.APPOINT_PUBLISH_DATE || row?.SCHEDULED_DATE || row?.FIRST_PUBLISH_DATE || row?.FIRST_SCHEDULED_DATE || row?.ACTUAL_PUBLISH_DATE || row?.ACTUAL_DATE);
    if (!code || !name || !scheduledDate) continue;
    const reportPeriod = String(row?.REPORT_TYPE_NAME || row?.REPORT_DATE_NAME || dateOnly(row?.REPORT_DATE) || '定期报告').trim();
    const key = `${scheduledDate}:${code}:${reportPeriod}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      date: scheduledDate,
      category: 'earnings',
      code,
      symbol: stockSymbolFromCode(code, row?.SECUCODE || row?.SECURITY_TYPE_CODE || ''),
      name,
      reportPeriod,
      actualDate: dateOnly(row?.ACTUAL_PUBLISH_DATE || row?.ACTUAL_DATE) || null,
      title: `${name}（${code}）预约披露 ${reportPeriod}`,
    });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

function formatBonusPlan(row) {
  const parts = [];
  const bonus = numberOrNull(row?.PRETAX_BONUS_RMB ?? row?.BONUS_IT_RATIO ?? row?.BONUS_RMB);
  const send = numberOrNull(row?.BONUS_RATIO ?? row?.SEND_GR_RATE);
  const trans = numberOrNull(row?.IT_RATIO ?? row?.RZR_GR_RATE);
  if (send && send > 0) parts.push(`送${send}股`);
  if (trans && trans > 0) parts.push(`转${trans}股`);
  if (bonus && bonus > 0) parts.push(`派${bonus}元(含税)`);
  if (parts.length) return `10${parts.join('')}`;
  const rawPlan = String(row?.IMPL_PLAN_PROFILE || row?.ASSIGN_PROGRESS || '').trim();
  return rawPlan || '分红派息除权除息';
}

function normalizeDividendCalendarPayload(payload) {
  const rows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const code = String(row?.SECURITY_CODE || '').trim();
    const name = String(row?.SECURITY_NAME_ABBR || '').trim();
    const exDate = dateOnly(row?.EX_DIVIDEND_DATE || row?.EQUITY_RECORD_DATE);
    if (!code || !name || !exDate) continue;
    const key = `${exDate}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const planText = formatBonusPlan(row);
    items.push({
      date: exDate,
      category: 'dividend',
      code,
      symbol: stockSymbolFromCode(code, row?.SECUCODE || ''),
      name,
      planText,
      dividendRatio: numberOrNull(row?.DIVIDENT_RATIO ?? row?.DIVIDEND_RATIO),
      recordDate: dateOnly(row?.EQUITY_RECORD_DATE) || null,
      title: `${name}（${code}）除权除息 · ${planText}`,
    });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

module.exports = {
  NEWS_CHANNELS,
  buildUpcomingMacroSchedule,
  normalizeDividendCalendarPayload,
  normalizeEarningsCalendarPayload,
  parseNewsFlashPayload,
  safeEastmoneyHttpsUrl,
};
