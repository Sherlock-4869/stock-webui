'use strict';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function poolSymbol(code, market) {
  if (!/^\d{6}$/.test(code)) return '';
  if (Number(market) === 1) return `sh${code}`;
  if (Number(market) === 0 && !/^[48]/.test(code)) return `sz${code}`;
  return '';
}

function normalizeBrokenLimitRow(row) {
  const code = String(row?.c || '');
  return {
    code,
    symbol:poolSymbol(code, row?.m),
    name:String(row?.n || ''),
    price:numberOrNull(row?.p) == null ? null : Number(row.p) / 1000,
    pct:numberOrNull(row?.zdp),
    amount:numberOrNull(row?.amount),
    floatMarketCap:numberOrNull(row?.ltsz),
    turnover:numberOrNull(row?.hs),
    amplitude:numberOrNull(row?.zf),
    firstSealTime:numberOrNull(row?.fbt),
    brokenCount:numberOrNull(row?.zbc) ?? 1,
    industry:String(row?.hybk || ''),
  };
}

function normalizeBrokenLimitPoolPayload(payload, date) {
  const data = payload?.data;
  const rows = Array.isArray(data?.pool) ? data.pool : [];
  const normalized = rows.map(normalizeBrokenLimitRow).filter(row => row.code && row.name);
  return {
    date:String(data?.qdate || date || ''),
    total:numberOrNull(data?.tc) ?? normalized.length,
    data:normalized,
  };
}

function normalizeYesterdayLimitRow(row) {
  const code = String(row?.c || '');
  return {
    code,
    symbol:poolSymbol(code, row?.m),
    name:String(row?.n || ''),
    price:numberOrNull(row?.p) == null ? null : Number(row.p) / 1000,
    pct:numberOrNull(row?.zdp),
    amount:numberOrNull(row?.amount),
    turnover:numberOrNull(row?.hs),
    amplitude:numberOrNull(row?.zf),
    yesterdayContinuous:numberOrNull(row?.zttj?.ct ?? row?.lbc ?? row?.ylbc),
    industry:String(row?.hybk || ''),
  };
}

function normalizeYesterdayLimitPoolPayload(payload, date) {
  const data = payload?.data;
  const rows = Array.isArray(data?.pool) ? data.pool : [];
  const normalized = rows.map(normalizeYesterdayLimitRow).filter(row => row.code && row.name);
  const pctValues = normalized.map(row => row.pct).filter(Number.isFinite);
  const avgPct = pctValues.length
    ? Math.round((pctValues.reduce((sum, val) => sum + val, 0) / pctValues.length) * 100) / 100
    : null;
  const risingCount = pctValues.filter(val => val > 0).length;
  const fallingCount = pctValues.filter(val => val < 0).length;
  const winRate = pctValues.length ? Math.round((risingCount / pctValues.length) * 1000) / 10 : null;
  return {
    date:String(data?.qdate || date || ''),
    total:numberOrNull(data?.tc) ?? normalized.length,
    avgPct,
    risingCount,
    fallingCount,
    winRate,
    data:normalized,
  };
}

function buildBoardLadder(limitUpRows) {
  const rows = Array.isArray(limitUpRows) ? limitUpRows : [];
  const buckets = new Map();
  let maxBoard = 0;
  for (const row of rows) {
    const count = Math.max(1, Math.trunc(Number(row?.continuousCount) || 1));
    if (count > maxBoard) maxBoard = count;
    if (!buckets.has(count)) buckets.set(count, []);
    buckets.get(count).push({
      code:String(row?.code || ''),
      symbol:String(row?.symbol || ''),
      name:String(row?.name || ''),
      pct:numberOrNull(row?.pct),
      continuousCount:count,
      firstSealTime:numberOrNull(row?.firstSealTime),
      sealAmount:numberOrNull(row?.sealAmount),
      industry:String(row?.industry || ''),
    });
  }
  const levels = [...buckets.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([boards, stocks]) => ({
      boards,
      label:boards === 1 ? '首板' : `${boards} 连板`,
      count:stocks.length,
      stocks:stocks.sort((a, b) => (a.firstSealTime || 999999) - (b.firstSealTime || 999999)),
    }));
  const industryCounts = new Map();
  for (const row of rows) {
    const industry = String(row?.industry || '').trim();
    if (!industry) continue;
    industryCounts.set(industry, (industryCounts.get(industry) || 0) + 1);
  }
  const hotThemes = [...industryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([industry, count]) => ({ industry, count }));
  return {
    maxBoard,
    total:rows.length,
    levels,
    hotThemes,
  };
}

function normalizeIndexTurnoverDelta(shDailyRows, szDailyRows) {
  const toMap = (rows) => {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = String(row?.[0] || '').slice(0, 10);
      // Tencent fqkline index row: [date, open, close, high, low, volume, ..., amount(万 or 元)]
      // Prefer explicit amount field when present, fallback to volume.
      const amount = numberOrNull(row?.[8]) ?? numberOrNull(row?.[5]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount != null && amount > 0) {
        map.set(date, amount);
      }
    }
    return map;
  };
  const shMap = toMap(shDailyRows);
  const szMap = toMap(szDailyRows);
  const commonDates = [...shMap.keys()].filter(date => szMap.has(date)).sort();
  if (commonDates.length < 2) return null;
  const latestDate = commonDates[commonDates.length - 1];
  const prevDate = commonDates[commonDates.length - 2];
  const latest = shMap.get(latestDate) + szMap.get(latestDate);
  const previous = shMap.get(prevDate) + szMap.get(prevDate);
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous <= 0) return null;
  const diffRatio = Math.round(((latest - previous) / previous) * 10000) / 100;
  return {
    latestDate,
    previousDate:prevDate,
    diffRatio,
  };
}

function computeMarketSentiment({
  breadth = null,
  limitUpTotal = 0,
  limitDownTotal = 0,
  brokenTotal = 0,
  yesterdayAvgPct = null,
  turnoverDiffRatio = null,
} = {}) {
  const rising = Number(breadth?.rising) || 0;
  const falling = Number(breadth?.falling) || 0;
  const flat = Number(breadth?.flat) || 0;
  const totalBreadth = rising + falling + flat;
  const riseRatio = totalBreadth > 0 ? Math.round((rising / totalBreadth) * 1000) / 10 : null;

  const limitAttempts = limitUpTotal + brokenTotal;
  const sealRate = limitAttempts > 0 ? Math.round((limitUpTotal / limitAttempts) * 1000) / 10 : null;

  let score = 50;
  let factors = 0;
  if (riseRatio != null) {
    score += (riseRatio - 50) * 0.6;
    factors += 1;
  }
  if (sealRate != null) {
    score += (sealRate - 65) * 0.35;
    factors += 1;
  }
  if (limitUpTotal > 0 || limitDownTotal > 0) {
    const limitBalance = (limitUpTotal - limitDownTotal * 1.5) / Math.max(20, limitUpTotal + limitDownTotal);
    score += limitBalance * 15;
    factors += 1;
  }
  if (Number.isFinite(yesterdayAvgPct)) {
    score += Math.max(-12, Math.min(12, yesterdayAvgPct * 3));
    factors += 1;
  }
  if (Number.isFinite(turnoverDiffRatio)) {
    score += Math.max(-5, Math.min(5, turnoverDiffRatio * 0.25));
  }

  const finalScore = factors ? Math.max(0, Math.min(100, Math.round(score))) : null;
  let label = '待观察';
  let tone = 'flat';
  if (finalScore != null) {
    if (finalScore >= 72) { label = '情绪亢奋'; tone = 'up'; }
    else if (finalScore >= 58) { label = '偏暖活跃'; tone = 'up'; }
    else if (finalScore >= 43) { label = '震荡分化'; tone = 'flat'; }
    else if (finalScore >= 28) { label = '偏弱谨慎'; tone = 'down'; }
    else { label = '情绪冰点'; tone = 'down'; }
  }

  return {
    score:finalScore,
    label,
    tone,
    riseRatio,
    sealRate,
    limitAttempts,
  };
}

function formatMoneyText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  const abs = Math.abs(num);
  const sign = num > 0 ? '+' : num < 0 ? '-' : '';
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${Math.round(abs)}`;
}

function formatPlainAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '--';
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}万亿`;
  if (num >= 1e8) return `${(num / 1e8).toFixed(2)}亿`;
  if (num >= 1e4) return `${(num / 1e4).toFixed(2)}万`;
  return String(Math.round(num));
}

function buildRecapMarkdown(recap) {
  const dateStr = String(recap?.date || new Date().toISOString().slice(0, 10));
  const displayDate = /^\d{8}$/.test(dateStr)
    ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
    : dateStr;
  const lines = [`# A 股每日市场复盘（${displayDate}）`, ''];

  const sentiment = recap?.sentiment || {};
  const breadth = recap?.breadth || {};
  const trading = recap?.trading || {};
  const turnover = recap?.turnoverComparison || null;
  const turnoverNote = turnover && Number.isFinite(turnover.diffRatio)
    ? `（较前一日 ${turnover.diffRatio >= 0 ? '放量' : '缩量'} ${Math.abs(turnover.diffRatio).toFixed(2)}%）`
    : '';

  lines.push('## 一、市场全景与情绪');
  lines.push(`- **情绪温度**：${sentiment.label || '--'}${sentiment.score != null ? `（${sentiment.score} 分）` : ''}`);
  lines.push(`- **两市成交额**：${formatPlainAmount(trading.amount)}${turnoverNote}`);
  lines.push(`- **涨跌分布**：上涨 ${breadth.rising ?? '--'} 家 / 平盘 ${breadth.flat ?? '--'} 家 / 下跌 ${breadth.falling ?? '--'} 家${sentiment.riseRatio != null ? `（上涨占比 ${sentiment.riseRatio}%）` : ''}`);
  lines.push(`- **涨跌停生态**：涨停 ${recap?.limits?.upTotal ?? '--'} 家、跌停 ${recap?.limits?.downTotal ?? '--'} 家、炸板 ${recap?.limits?.brokenTotal ?? '--'} 家${sentiment.sealRate != null ? `（封板率 ${sentiment.sealRate}%）` : ''}`);
  if (recap?.yesterdayLimit?.total) {
    const avg = recap.yesterdayLimit.avgPct;
    lines.push(`- **昨日涨停表现**：共 ${recap.yesterdayLimit.total} 家，今日平均 ${avg != null ? `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%` : '--'}，红盘率 ${recap.yesterdayLimit.winRate != null ? `${recap.yesterdayLimit.winRate}%` : '--'}`);
  }
  if (recap?.mainFlow?.mainNet != null) {
    lines.push(`- **沪深主力资金**：${formatMoneyText(recap.mainFlow.mainNet)}（超大单 ${formatMoneyText(recap.mainFlow.superLargeNet)}，大单 ${formatMoneyText(recap.mainFlow.largeNet)}）`);
  }
  lines.push('');

  const indexes = Array.isArray(recap?.indexes) ? recap.indexes : [];
  if (indexes.length) {
    lines.push('## 二、主要指数表现');
    lines.push('| 指数 | 最新点位 | 涨跌幅 |');
    lines.push('| --- | ---: | ---: |');
    for (const idx of indexes) {
      const pct = Number.isFinite(Number(idx.pct)) ? `${Number(idx.pct) >= 0 ? '+' : ''}${Number(idx.pct).toFixed(2)}%` : '--';
      lines.push(`| ${idx.name || idx.code} | ${idx.price ?? '--'} | ${pct} |`);
    }
    lines.push('');
  }

  const ladder = recap?.ladder || {};
  if (Array.isArray(ladder.levels) && ladder.levels.length) {
    lines.push('## 三、连板梯队与题材主线');
    lines.push(`- **最高连板**：${ladder.maxBoard ? `${ladder.maxBoard} 连板` : '--'}`);
    if (Array.isArray(ladder.hotThemes) && ladder.hotThemes.length) {
      lines.push(`- **涨停集中行业**：${ladder.hotThemes.slice(0, 6).map(item => `${item.industry}(${item.count})`).join('、')}`);
    }
    for (const level of ladder.levels.filter(item => item.boards >= 2).slice(0, 5)) {
      const names = level.stocks.slice(0, 8).map(stock => `${stock.name}${stock.industry ? `(${stock.industry})` : ''}`).join('、');
      lines.push(`- **${level.label}（${level.count} 家）**：${names}${level.stocks.length > 8 ? ' 等' : ''}`);
    }
    lines.push('');
  }

  const sectors = recap?.sectors || {};
  if ((sectors.rising && sectors.rising.length) || (sectors.falling && sectors.falling.length)) {
    lines.push('## 四、行业板块强弱');
    if (sectors.rising?.length) {
      lines.push(`- **领涨行业**：${sectors.rising.slice(0, 5).map(b => `${b.name} (${Number(b.pct) >= 0 ? '+' : ''}${Number(b.pct).toFixed(2)}%)`).join('、')}`);
    }
    if (sectors.falling?.length) {
      lines.push(`- **领跌行业**：${sectors.falling.slice(0, 5).map(b => `${b.name} (${Number(b.pct) >= 0 ? '+' : ''}${Number(b.pct).toFixed(2)}%)`).join('、')}`);
    }
    if (sectors.inflow?.length) {
      lines.push(`- **主力净流入行业**：${sectors.inflow.slice(0, 5).map(b => `${b.name} (${formatMoneyText(b.mainNetInflow)})`).join('、')}`);
    }
    lines.push('');
  }

  lines.push('## 五、个人复盘与明日计划');
  lines.push('- 今日主线与核心观察：');
  lines.push('- 持仓/自选复盘结论：');
  lines.push('- 明日关注与风控点位：');
  lines.push('');
  lines.push('> 以上数据整理自公开市场行情接口，仅供研究复盘，不构成投资建议。');
  return lines.join('\n');
}

module.exports = {
  buildBoardLadder,
  buildRecapMarkdown,
  computeMarketSentiment,
  normalizeBrokenLimitPoolPayload,
  normalizeBrokenLimitRow,
  normalizeIndexTurnoverDelta,
  normalizeYesterdayLimitPoolPayload,
  normalizeYesterdayLimitRow,
};
