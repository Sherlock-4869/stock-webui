'use strict';

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function zonedParts(date = new Date(), timezone = 'Asia/Shanghai') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return { ...parts, dateKey, weekday: new Date(`${dateKey}T00:00:00Z`).getUTCDay() };
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekRange(date = new Date(), timezone = 'Asia/Shanghai') {
  const parts = zonedParts(date, timezone);
  const daysSinceMonday = (parts.weekday + 6) % 7;
  const start = shiftDateKey(parts.dateKey, -daysSinceMonday);
  return { start, end: shiftDateKey(start, 6), local: parts };
}

function selectWeekIpos(rows, range) {
  return (Array.isArray(rows) ? rows : [])
    .filter(item => {
      const dateKey = String(item.applyDate || '').slice(0, 10);
      return dateKey >= range.start && dateKey <= range.end;
    })
    .sort((a, b) => String(a.applyDate).localeCompare(String(b.applyDate)) || String(a.code).localeCompare(String(b.code)));
}

function selectDailyIpos(rows, dateKey) {
  return selectWeekIpos(rows, { start: dateKey, end: dateKey });
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `${number.toFixed(2)}元` : '待公布';
}

function formatBoard(item = {}) {
  const board = String(item.board || '').trim();
  if (board) return board;

  const code = String(item.code || '').trim();
  const market = String(item.market || '').trim();
  if (/^(688|689)/.test(code)) return '科创板';
  if (/^(300|301)/.test(code)) return '创业板';
  if (/^(4|8|92)/.test(code) || market.includes('北京') || market.includes('北交')) return '北交所';
  if (/^(600|601|603|605)/.test(code) || market.includes('上海')) return '沪市主板';
  if (/^(000|001|002|003)/.test(code) || market.includes('深圳')) return '深市主板';
  return '待确认';
}

function buildWeeklyMessage(items, range, pageUrl) {
  const lines = [`【本周新股申购】`, `${range.start} 至 ${range.end}`];
  if (!items.length) {
    lines.push('', '本周暂无可申购新股。');
  } else {
    lines.push('', `共 ${items.length} 只：`);
    items.slice(0, 20).forEach((item, index) => {
      const dateKey = String(item.applyDate || '').slice(0, 10);
      const weekday = WEEKDAY_NAMES[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
      lines.push(`${index + 1}. ${item.name || '--'}（${item.applyCode || item.code || '--'}）`);
      lines.push(`   ${dateKey} ${weekday}｜板块 ${formatBoard(item)}｜发行价 ${formatPrice(item.price)}`);
    });
    if (items.length > 20) lines.push(`另有 ${items.length - 20} 只，请打开页面查看。`);
  }
  lines.push('', `详情：${pageUrl}`, '数据以交易所最终公告为准，不构成投资建议。');
  const content = lines.join('\n');
  return content.length <= 1900 ? content : `${content.slice(0, 1870)}\n…\n详情：${pageUrl}`;
}

function buildDailyMessage(items, dateKey, pageUrl) {
  const weekday = WEEKDAY_NAMES[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
  const lines = ['【今日新股申购提醒】', `${dateKey} ${weekday}`];
  if (!items.length) {
    lines.push('', '今日暂无可申购新股。');
  } else {
    lines.push('', `今日共 ${items.length} 只：`);
    items.slice(0, 20).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name || '--'}（${item.applyCode || item.code || '--'}）`);
      lines.push(`   板块 ${formatBoard(item)}｜发行价 ${formatPrice(item.price)}`);
    });
    if (items.length > 20) lines.push(`另有 ${items.length - 20} 只，请打开页面查看。`);
  }
  lines.push('', `详情：${pageUrl}`, '数据以交易所最终公告为准，不构成投资建议。');
  const content = lines.join('\n');
  return content.length <= 1900 ? content : `${content.slice(0, 1870)}\n…\n详情：${pageUrl}`;
}

module.exports = {
  zonedParts,
  shiftDateKey,
  weekRange,
  selectWeekIpos,
  selectDailyIpos,
  formatBoard,
  buildWeeklyMessage,
  buildDailyMessage,
};
