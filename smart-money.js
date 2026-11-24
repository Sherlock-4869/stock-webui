'use strict';

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateOnly(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
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

function normalizeLhbListPayload(payload) {
  const rawRows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const merged = new Map();
  let latestDate = '';

  for (const row of rawRows) {
    const code = String(row?.SECURITY_CODE || row?.SCODE || '').trim();
    const name = String(row?.SECURITY_NAME_ABBR || row?.NAME || '').trim();
    const tradeDate = dateOnly(row?.TRADE_DATE);
    if (!code || !name || !tradeDate) continue;
    if (!latestDate || tradeDate > latestDate) latestDate = tradeDate;
    const key = `${tradeDate}:${code}`;
    const reason = String(row?.EXPLANATION || row?.REASON || '').trim();
    const existing = merged.get(key);
    if (existing) {
      if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
      continue;
    }
    merged.set(key, {
      code,
      symbol:stockSymbolFromCode(code, row?.SECUCODE || row?.EXCHANGE || ''),
      secuCode:String(row?.SECUCODE || ''),
      name,
      tradeDate,
      closePrice:numberOrNull(row?.CLOSE_PRICE),
      pct:numberOrNull(row?.CHANGE_RATE),
      turnoverRate:numberOrNull(row?.TURNOVER_RATE),
      buyAmount:numberOrNull(row?.BILLBOARD_BUY_AMT),
      sellAmount:numberOrNull(row?.BILLBOARD_SELL_AMT),
      netAmount:numberOrNull(row?.BILLBOARD_NET_AMT),
      dealAmount:numberOrNull(row?.BILLBOARD_DEAL_AMT),
      marketAmount:numberOrNull(row?.ACCUM_AMOUNT ?? row?.MARKET_TOTAL_AMT),
      netRatio:numberOrNull(row?.NET_BUY_AMT_RATIO),
      dealRatio:numberOrNull(row?.DEAL_AMT_RATIO),
      floatMarketCap:numberOrNull(row?.FREE_MARKET_CAP ?? row?.CIRCULATE_MARKET_VALUE),
      reasons:reason ? [reason] : [],
    });
  }

  const rows = [...merged.values()].sort((left, right) => {
    if (right.tradeDate !== left.tradeDate) return right.tradeDate.localeCompare(left.tradeDate);
    return (Number(right.netAmount) || -Infinity) - (Number(left.netAmount) || -Infinity);
  });

  let totalNetBuy = 0;
  let netBuyCount = 0;
  let netSellCount = 0;
  for (const item of rows) {
    if (Number.isFinite(item.netAmount)) {
      totalNetBuy += item.netAmount;
      if (item.netAmount > 0) netBuyCount += 1;
      else if (item.netAmount < 0) netSellCount += 1;
    }
  }

  return {
    tradeDate:latestDate,
    total:rows.length,
    summary:{
      totalCount:rows.length,
      totalNetBuy,
      netBuyCount,
      netSellCount,
    },
    data:rows,
  };
}

function normalizeLhbSeatRow(row, side) {
  const deptName = String(row?.OPERATEDEPT_NAME || '').trim();
  const buy = numberOrNull(row?.BUY) ?? 0;
  const sell = numberOrNull(row?.SELL) ?? 0;
  const net = numberOrNull(row?.NET) ?? (buy - sell);
  return {
    side,
    rank:numberOrNull(row?.RANK),
    deptCode:String(row?.OPERATEDEPT_CODE || ''),
    deptName,
    isInstitution:deptName.includes('机构专用'),
    isNorthbound:deptName.includes('沪股通专用') || deptName.includes('深股通专用'),
    buyAmount:buy,
    sellAmount:sell,
    netAmount:net,
    buyRatio:numberOrNull(row?.TOTAL_BUYRIO),
    sellRatio:numberOrNull(row?.TOTAL_SELLRIO),
    reason:String(row?.EXPLANATION || '').trim(),
  };
}

function dedupeSeats(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!row.deptName) continue;
    const key = `${row.deptCode || row.deptName}:${row.buyAmount}:${row.sellAmount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function normalizeLhbSeatsPayload(buyPayload, sellPayload) {
  const rawBuy = Array.isArray(buyPayload?.result?.data) ? buyPayload.result.data : [];
  const rawSell = Array.isArray(sellPayload?.result?.data) ? sellPayload.result.data : [];
  const buySeats = dedupeSeats(rawBuy.map(row => normalizeLhbSeatRow(row, 'buy')))
    .sort((a, b) => b.buyAmount - a.buyAmount)
    .slice(0, 10);
  const sellSeats = dedupeSeats(rawSell.map(row => normalizeLhbSeatRow(row, 'sell')))
    .sort((a, b) => b.sellAmount - a.sellAmount)
    .slice(0, 10);

  const instBuy = buySeats.filter(seat => seat.isInstitution);
  const instSell = sellSeats.filter(seat => seat.isInstitution);
  const institutionBuyAmount = instBuy.reduce((sum, seat) => sum + seat.buyAmount, 0);
  const institutionSellAmount = instSell.reduce((sum, seat) => sum + seat.sellAmount, 0);
  return {
    buySeats,
    sellSeats,
    institutionSummary:{
      buyCount:instBuy.length,
      sellCount:instSell.length,
      buyAmount:institutionBuyAmount,
      sellAmount:institutionSellAmount,
      netAmount:institutionBuyAmount - institutionSellAmount,
    },
  };
}

function normalizeLhbInstitutionPayload(payload) {
  const rawRows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const merged = new Map();
  let latestDate = '';
  for (const row of rawRows) {
    const code = String(row?.SECURITY_CODE || '').trim();
    const name = String(row?.SECURITY_NAME_ABBR || '').trim();
    const tradeDate = dateOnly(row?.TRADE_DATE);
    if (!code || !name || !tradeDate) continue;
    if (!latestDate || tradeDate > latestDate) latestDate = tradeDate;
    const key = `${tradeDate}:${code}`;
    if (merged.has(key)) continue;
    merged.set(key, {
      code,
      symbol:stockSymbolFromCode(code, row?.SECUCODE || ''),
      name,
      tradeDate,
      closePrice:numberOrNull(row?.CLOSE_PRICE),
      pct:numberOrNull(row?.CHANGE_RATE),
      buyAmount:numberOrNull(row?.BUY_AMT ?? row?.BUY),
      sellAmount:numberOrNull(row?.SELL_AMT ?? row?.SELL),
      netAmount:numberOrNull(row?.NET_BUY_AMT ?? row?.NET_AMT ?? row?.NET),
      buyOrgCount:numberOrNull(row?.BUY_TIMES ?? row?.BUY_CG_COUNT),
      sellOrgCount:numberOrNull(row?.SELL_TIMES ?? row?.SELL_CG_COUNT),
      reason:String(row?.EXPLANATION || '').trim(),
    });
  }
  const rows = [...merged.values()].sort((a, b) => (Number(b.netAmount) || -Infinity) - (Number(a.netAmount) || -Infinity));
  return {
    tradeDate:latestDate,
    total:rows.length,
    data:rows,
  };
}

function normalizeMarginMarketPayload(payload) {
  const rawRows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const points = rawRows.map(row => {
    const date = dateOnly(row?.DIM_DATE || row?.DATE || row?.TRADE_DATE);
    const rzBalance = numberOrNull(row?.RZYE);
    const rqBalance = numberOrNull(row?.RQYE);
    const totalBalance = numberOrNull(row?.RZRQYE) ?? (rzBalance != null && rqBalance != null ? rzBalance + rqBalance : rzBalance);
    const rzBuy = numberOrNull(row?.RZMRE);
    const rzRepay = numberOrNull(row?.RZCHE);
    const rzNetBuy = numberOrNull(row?.RZJME) ?? (rzBuy != null && rzRepay != null ? rzBuy - rzRepay : null);
    return {
      date,
      rzBalance,
      rqBalance,
      totalBalance,
      rzBuy,
      rzRepay,
      rzNetBuy,
    };
  }).filter(item => item.date && item.totalBalance != null)
    .sort((left, right) => left.date.localeCompare(right.date));

  const latest = points.length ? points[points.length - 1] : null;
  const previous = points.length >= 2 ? points[points.length - 2] : null;
  const balanceDelta = latest && previous && latest.totalBalance != null && previous.totalBalance != null
    ? latest.totalBalance - previous.totalBalance
    : null;
  const rzBalanceDelta = latest && previous && latest.rzBalance != null && previous.rzBalance != null
    ? latest.rzBalance - previous.rzBalance
    : null;

  return {
    latestDate:latest?.date || '',
    latest:latest ? { ...latest, balanceDelta, rzBalanceDelta } : null,
    series:points,
  };
}

function normalizeMarginStocksPayload(payload) {
  const rawRows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  let latestDate = '';
  const rows = [];
  for (const row of rawRows) {
    const code = String(row?.SCODE || row?.SECURITY_CODE || '').trim();
    const name = String(row?.SECNAME || row?.SECURITY_NAME_ABBR || '').trim();
    const tradeDate = dateOnly(row?.DATE || row?.TRADE_DATE);
    if (!code || !name) continue;
    if (tradeDate && (!latestDate || tradeDate > latestDate)) latestDate = tradeDate;
    const rzBuy = numberOrNull(row?.RZMRE);
    const rzRepay = numberOrNull(row?.RZCHE);
    const rzNetBuy = numberOrNull(row?.RZJME) ?? (rzBuy != null && rzRepay != null ? rzBuy - rzRepay : null);
    rows.push({
      code,
      symbol:stockSymbolFromCode(code, row?.MARKET || row?.SECUCODE || ''),
      name,
      tradeDate,
      closePrice:numberOrNull(row?.SPJ ?? row?.CLOSE_PRICE),
      pct:numberOrNull(row?.ZDF ?? row?.CHANGE_RATE),
      rzBalance:numberOrNull(row?.RZYE),
      rzBalanceRatio:numberOrNull(row?.RZYEZB),
      rzBuy,
      rzRepay,
      rzNetBuy,
      rqBalance:numberOrNull(row?.RQYE),
      rqVolume:numberOrNull(row?.RQYL),
      totalBalance:numberOrNull(row?.RZRQYE),
    });
  }
  return {
    tradeDate:latestDate,
    total:rows.length,
    data:rows,
  };
}

function normalizeUnlockPayload(payload, { todayKey = '' } = {}) {
  const rawRows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const rows = [];
  for (const row of rawRows) {
    const code = String(row?.SECURITY_CODE || '').trim();
    const name = String(row?.SECURITY_NAME_ABBR || '').trim();
    const freeDate = dateOnly(row?.FREE_DATE);
    if (!code || !name || !freeDate) continue;
    // Eastmoney RPT_LIFT_STAGE ratios may be decimal (0.05) or already percentage (5.0).
    // FREE_RATIO / TOTAL_RATIO are decimals in RPT_LIFT_STAGE (e.g. 0.1234 => 12.34%).
    const rawTotalRatio = numberOrNull(row?.TOTAL_RATIO ?? row?.FREE_RATIO);
    const rawFloatRatio = numberOrNull(row?.NON_FREE_RATIO ?? row?.FREE_RATIO);
    const toPct = (v) => {
      if (v == null) return null;
      return v <= 1 ? Math.round(v * 10000) / 100 : Math.round(v * 100) / 100;
    };
    const freeShares = numberOrNull(row?.FREE_SHARES ?? row?.FREE_SHARES_NUM);
    const ableFreeShares = numberOrNull(row?.ABLE_FREE_SHARES);
    const liftMarketCap = numberOrNull(row?.LIFT_MARKET_CAP);
    rows.push({
      code,
      symbol:stockSymbolFromCode(code, row?.SECUCODE || ''),
      name,
      freeDate,
      shareType:String(row?.FREE_SHARES_TYPE || row?.LIMITED_STOCK_TYPE || '限售股份').trim(),
      freeShares,
      ableFreeShares,
      liftMarketCap,
      totalRatioPct:toPct(rawTotalRatio),
      floatRatioPct:toPct(rawFloatRatio),
      batchCount:numberOrNull(row?.BATCH_HOLDER_NUM),
    });
  }

  rows.sort((left, right) => {
    if (left.freeDate !== right.freeDate) return left.freeDate.localeCompare(right.freeDate);
    return (Number(right.liftMarketCap) || 0) - (Number(left.liftMarketCap) || 0);
  });

  const totalMarketCap = rows.reduce((sum, item) => sum + (Number(item.liftMarketCap) || 0), 0);
  const highPressureCount = rows.filter(item => Number(item.totalRatioPct) >= 10 || Number(item.liftMarketCap) >= 2e9).length;
  const sevenDayCutoff = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return '';
    const d = new Date(`${todayKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();
  const next7DaysCount = sevenDayCutoff
    ? rows.filter(item => item.freeDate >= todayKey && item.freeDate <= sevenDayCutoff).length
    : 0;

  return {
    total:rows.length,
    summary:{
      totalCount:rows.length,
      totalMarketCap,
      highPressureCount,
      next7DaysCount,
    },
    data:rows,
  };
}

module.exports = {
  normalizeLhbInstitutionPayload,
  normalizeLhbListPayload,
  normalizeLhbSeatsPayload,
  normalizeMarginMarketPayload,
  normalizeMarginStocksPayload,
  normalizeUnlockPayload,
  stockSymbolFromCode,
};
