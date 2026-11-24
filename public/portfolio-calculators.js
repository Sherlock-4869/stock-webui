'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PortfolioCalculators = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function finite(value, fallback = null) {
    if (value === '' || value == null) return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function round(value, digits = 2) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function classifyMarket(symbol) {
    const sym = String(symbol || '').trim().toLowerCase();
    if (/^fund\d{6}$/.test(sym) || /^(?:sh5\d{5}|sz15\d{4})$/.test(sym)) {
      return { key: 'fund', label: 'ETF 与基金' };
    }
    if (/^sh688\d{3}$/.test(sym)) return { key: 'kcb', label: '科创板' };
    if (/^sz30\d{4}$/.test(sym)) return { key: 'cyb', label: '创业板' };
    if (/^sh\d{6}$/.test(sym)) return { key: 'sh', label: '沪市主板' };
    if (/^sz\d{6}$/.test(sym)) return { key: 'sz', label: '深市主板' };
    if (/^hk/i.test(sym)) return { key: 'hk', label: '港股' };
    if (/^us/i.test(sym)) return { key: 'us', label: '美股' };
    return { key: 'other', label: '其他市场' };
  }

  function analyzePortfolio(positions = [], trades = [], quotes = {}) {
    // 1. Realized PnL & Win/Loss statistics from chronological trade log
    const orderedTrades = [...(Array.isArray(trades) ? trades : [])]
      .map((t, index) => ({ ...t, _idx: index }))
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || a._idx - b._idx);

    const book = new Map();
    let realizedProfit = 0;
    let grossWins = 0;
    let grossLosses = 0;
    let winCount = 0;
    let lossCount = 0;
    const closedSellRecords = [];

    for (const trade of orderedTrades) {
      const symbol = String(trade.symbol || '').trim().toLowerCase();
      const qty = finite(trade.quantity, 0);
      const price = finite(trade.price, 0);
      if (!symbol || qty <= 0 || price <= 0) continue;
      const side = String(trade.side || '').toUpperCase();
      const entry = book.get(symbol) || { qty: 0, avgCost: 0 };

      if (side === 'SELL') {
        if (entry.qty > 0) {
          const matchedQty = Math.min(entry.qty, qty);
          const pnl = (price - entry.avgCost) * matchedQty;
          realizedProfit += pnl;
          if (pnl > 0) {
            winCount += 1;
            grossWins += pnl;
          } else if (pnl < 0) {
            lossCount += 1;
            grossLosses += Math.abs(pnl);
          }
          closedSellRecords.push({
            symbol,
            name: trade.name || symbol,
            at: trade.at || 0,
            quantity: matchedQty,
            sellPrice: price,
            avgCost: round(entry.avgCost, 4),
            pnl: round(pnl, 2),
          });
          entry.qty = Math.max(0, entry.qty - matchedQty);
          if (entry.qty === 0) entry.avgCost = 0;
          book.set(symbol, entry);
        }
      } else {
        const nextQty = entry.qty + qty;
        entry.avgCost = (entry.avgCost * entry.qty + price * qty) / nextQty;
        entry.qty = nextQty;
        book.set(symbol, entry);
      }
    }

    // 2. Current open positions valuation & allocation
    let totalCost = 0;
    let totalMarketValue = 0;
    const marketBuckets = new Map();
    const enrichedPositions = (Array.isArray(positions) ? positions : []).map(pos => {
      const symbol = String(pos.symbol || '').trim().toLowerCase();
      const qty = finite(pos.quantity, 0);
      const cost = finite(pos.cost, 0);
      const livePrice = finite(quotes[symbol]?.price) ?? finite(pos.lastPrice) ?? cost;
      const costValue = qty * cost;
      const marketValue = qty * livePrice;
      const unrealized = marketValue - costValue;
      const returnPct = costValue > 0 ? (unrealized / costValue) * 100 : 0;
      totalCost += costValue;
      totalMarketValue += marketValue;
      const market = classifyMarket(symbol);
      marketBuckets.set(market.key, {
        key: market.key,
        label: market.label,
        value: (marketBuckets.get(market.key)?.value || 0) + marketValue,
        count: (marketBuckets.get(market.key)?.count || 0) + 1,
      });
      return {
        symbol,
        name: String(pos.name || quotes[symbol]?.name || symbol),
        marketLabel: market.label,
        quantity: qty,
        cost,
        price: livePrice,
        costValue,
        marketValue,
        unrealized,
        returnPct,
      };
    }).filter(p => p.quantity > 0);

    enrichedPositions.sort((a, b) => b.marketValue - a.marketValue);
    enrichedPositions.forEach(p => {
      p.weightPct = totalMarketValue > 0 ? round((p.marketValue / totalMarketValue) * 100, 2) : 0;
    });

    const marketAllocation = [...marketBuckets.values()]
      .sort((a, b) => b.value - a.value)
      .map(bucket => ({
        ...bucket,
        weightPct: totalMarketValue > 0 ? round((bucket.value / totalMarketValue) * 100, 2) : 0,
      }));

    const unrealizedProfit = totalMarketValue - totalCost;
    const totalProfit = realizedProfit + unrealizedProfit;
    const closedCount = winCount + lossCount;
    const winRatePct = closedCount > 0 ? round((winCount / closedCount) * 100, 1) : null;
    const avgWin = winCount > 0 ? grossWins / winCount : 0;
    const avgLoss = lossCount > 0 ? grossLosses / lossCount : 0;
    const profitFactor = avgLoss > 0 ? round(avgWin / avgLoss, 2) : (winCount > 0 ? Infinity : null);

    return {
      totalCost: round(totalCost, 2),
      totalMarketValue: round(totalMarketValue, 2),
      unrealizedProfit: round(unrealizedProfit, 2),
      unrealizedPct: totalCost > 0 ? round((unrealizedProfit / totalCost) * 100, 2) : null,
      realizedProfit: round(realizedProfit, 2),
      totalProfit: round(totalProfit, 2),
      closedCount,
      winCount,
      lossCount,
      winRatePct,
      profitFactor,
      positions: enrichedPositions,
      marketAllocation,
      closedSellRecords: closedSellRecords.reverse(),
    };
  }

  function comparePortfolioWithBenchmark(positionSeriesMap, weightsMap, benchmarkRows) {
    // benchmarkRows: [{ date: 'YYYY-MM-DD', close: Number }]
    const bench = (Array.isArray(benchmarkRows) ? benchmarkRows : [])
      .filter(r => r?.date && Number.isFinite(Number(r.close)) && Number(r.close) > 0);
    if (bench.length < 5) return null;

    const symbols = Object.keys(weightsMap || {}).filter(sym => (weightsMap[sym] || 0) > 0 && Array.isArray(positionSeriesMap?.[sym]) && positionSeriesMap[sym].length >= 5);
    if (!symbols.length) return null;

    const priceBySymDate = {};
    for (const sym of symbols) {
      const map = new Map();
      for (const pt of positionSeriesMap[sym]) {
        if (pt?.date && Number.isFinite(Number(pt.close)) && Number(pt.close) > 0) {
          map.set(pt.date, Number(pt.close));
        }
      }
      priceBySymDate[sym] = map;
    }

    const commonDates = bench
      .map(b => b.date)
      .filter(date => symbols.every(sym => priceBySymDate[sym].has(date)));
    if (commonDates.length < 5) return null;

    const benchMap = new Map(bench.map(b => [b.date, Number(b.close)]));
    const baseBench = benchMap.get(commonDates[0]);
    const totalWeight = symbols.reduce((sum, sym) => sum + Number(weightsMap[sym] || 0), 0) || 1;
    const basePrices = Object.fromEntries(symbols.map(sym => [sym, priceBySymDate[sym].get(commonDates[0])]));

    let peakNav = 1;
    let maxDrawdownPct = 0;
    const points = commonDates.map(date => {
      const portfolioNav = symbols.reduce((acc, sym) => {
        const w = Number(weightsMap[sym] || 0) / totalWeight;
        const ratio = priceBySymDate[sym].get(date) / basePrices[sym];
        return acc + w * ratio;
      }, 0);
      if (portfolioNav > peakNav) peakNav = portfolioNav;
      const dd = ((peakNav - portfolioNav) / peakNav) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      const benchNav = benchMap.get(date) / baseBench;
      return {
        date,
        portfolioPct: round((portfolioNav - 1) * 100, 2),
        benchmarkPct: round((benchNav - 1) * 100, 2),
      };
    });

    const last = points[points.length - 1];
    return {
      startDate: commonDates[0],
      endDate: last.date,
      sessions: points.length,
      portfolioReturnPct: last.portfolioPct,
      benchmarkReturnPct: last.benchmarkPct,
      alphaPct: round(last.portfolioPct - last.benchmarkPct, 2),
      maxDrawdownPct: round(maxDrawdownPct, 2),
      points,
    };
  }

  // Calculator 1: Averaging-Down / Cost Dilution Calculator
  function calculateCostDilution({
    currentShares,
    currentCost,
    buyPrice,
    addShares = null,
    targetCost = null,
  } = {}) {
    const shares = finite(currentShares, 0);
    const cost = finite(currentCost, 0);
    const price = finite(buyPrice, 0);
    if (shares <= 0 || cost <= 0 || price <= 0) return null;

    const currentLossPct = ((price - cost) / cost) * 100;
    const reboundNeededBeforePct = ((cost - price) / price) * 100;

    let resolvedAddShares = finite(addShares, null);
    let warning = '';
    if (targetCost != null && targetCost !== '') {
      const target = finite(targetCost, 0);
      if (target > 0) {
        if ((cost > price && (target <= price || target >= cost)) || (cost < price && (target >= price || target <= cost))) {
          warning = '目标成本价必须介于原成本价与拟补仓价格之间';
          resolvedAddShares = 0;
        } else {
          resolvedAddShares = (shares * (cost - target)) / (target - price);
        }
      }
    }
    if (resolvedAddShares == null || resolvedAddShares < 0) resolvedAddShares = 0;

    const totalShares = shares + resolvedAddShares;
    const addAmount = resolvedAddShares * price;
    const totalInvested = shares * cost + addAmount;
    const newCost = totalShares > 0 ? totalInvested / totalShares : cost;
    const reboundNeededAfterPct = ((newCost - price) / price) * 100;

    return {
      currentShares: round(shares, 2),
      currentCost: round(cost, 4),
      buyPrice: round(price, 4),
      addShares: round(resolvedAddShares, 2),
      lotAlignedShares: Math.ceil(resolvedAddShares / 100) * 100,
      addAmount: round(addAmount, 2),
      totalShares: round(totalShares, 2),
      totalInvested: round(totalInvested, 2),
      newCost: round(newCost, 4),
      costReduction: round(cost - newCost, 4),
      currentFloatingPct: round(currentLossPct, 2),
      reboundNeededBeforePct: round(reboundNeededBeforePct, 2),
      reboundNeededAfterPct: round(reboundNeededAfterPct, 2),
      warning,
    };
  }

  // Calculator 2: Grid Trading Schedule & Capital Calculator
  function calculateGridPlan({
    lowerPrice,
    upperPrice,
    gridCount = 8,
    perGridAmount = 10000,
    mode = 'arithmetic', // 'arithmetic' | 'geometric'
    feeRate = 0.0003,
  } = {}) {
    const low = finite(lowerPrice, 0);
    const high = finite(upperPrice, 0);
    const count = Math.min(50, Math.max(2, Math.trunc(finite(gridCount, 8))));
    const budgetPerGrid = finite(perGridAmount, 0);
    const fee = Math.max(0, finite(feeRate, 0.0003));
    if (low <= 0 || high <= low || budgetPerGrid <= 0) return null;

    const prices = [];
    if (mode === 'geometric') {
      const ratio = (high / low) ** (1 / count);
      for (let i = 0; i <= count; i += 1) prices.push(low * (ratio ** i));
    } else {
      const step = (high - low) / count;
      for (let i = 0; i <= count; i += 1) prices.push(low + step * i);
    }

    const levels = [];
    let totalMaxCapital = 0;
    let totalMaxShares = 0;
    for (let i = 0; i < count; i += 1) {
      const buyTrigger = prices[i];
      const sellTrigger = prices[i + 1];
      const rawShares = budgetPerGrid / buyTrigger;
      const lotShares = Math.max(100, Math.floor(rawShares / 100) * 100);
      const capital = lotShares * buyTrigger;
      const grossProfit = lotShares * (sellTrigger - buyTrigger);
      const estFees = lotShares * (buyTrigger + sellTrigger) * fee;
      const netProfit = grossProfit - estFees;
      const gridYieldPct = (netProfit / capital) * 100;
      totalMaxCapital += capital;
      totalMaxShares += lotShares;
      levels.push({
        level: i + 1,
        buyPrice: round(buyTrigger, 3),
        sellPrice: round(sellTrigger, 3),
        shares: lotShares,
        capital: round(capital, 2),
        netProfit: round(netProfit, 2),
        yieldPct: round(gridYieldPct, 2),
      });
    }

    const yields = levels.map(l => l.yieldPct);
    return {
      mode,
      gridCount: count,
      lowerPrice: round(low, 3),
      upperPrice: round(high, 3),
      amplitudePct: round(((high - low) / low) * 100, 2),
      minYieldPct: round(Math.min(...yields), 2),
      maxYieldPct: round(Math.max(...yields), 2),
      totalMaxCapital: round(totalMaxCapital, 2),
      totalMaxShares,
      levels: levels.reverse(), // high to low for intuitive visual ladder
    };
  }

  // Calculator 3A: Compounding DCA (Fixed Periodic Investment) Simulator
  function simulateCompoundDca({
    periodicAmount = 3000,
    periodsPerYear = 12,
    annualReturnPct = 8,
    years = 10,
  } = {}) {
    const pmt = finite(periodicAmount, 0);
    const freq = Math.max(1, Math.trunc(finite(periodsPerYear, 12)));
    const rate = finite(annualReturnPct, 0) / 100;
    const yrs = Math.min(50, Math.max(1, finite(years, 10)));
    if (pmt <= 0) return null;

    const totalPeriods = Math.round(yrs * freq);
    const r = rate / freq;
    let balance = 0;
    let principal = 0;
    const yearly = [];

    for (let step = 1; step <= totalPeriods; step += 1) {
      principal += pmt;
      balance = (balance + pmt) * (1 + r);
      if (step % freq === 0 || step === totalPeriods) {
        yearly.push({
          year: round(step / freq, 1),
          principal: round(principal, 2),
          balance: round(balance, 2),
          profit: round(balance - principal, 2),
          returnPct: round(((balance - principal) / principal) * 100, 2),
        });
      }
    }

    return {
      totalPeriods,
      principal: round(principal, 2),
      finalBalance: round(balance, 2),
      totalProfit: round(balance - principal, 2),
      totalReturnPct: round(((balance - principal) / principal) * 100, 2),
      yearly,
    };
  }

  // Calculator 3B: Historical K-Line DCA Backtest
  function backtestHistoricalDca(klineRows = [], { periodicAmount = 2000, intervalSessions = 20 } = {}) {
    const rows = (Array.isArray(klineRows) ? klineRows : [])
      .filter(r => r?.date && finite(r.close, 0) > 0);
    const pmt = finite(periodicAmount, 0);
    const step = Math.max(1, Math.trunc(finite(intervalSessions, 20)));
    if (rows.length < 5 || pmt <= 0) return null;

    let totalInvested = 0;
    let totalShares = 0;
    let installments = 0;

    for (let i = 0; i < rows.length; i += step) {
      const price = Number(rows[i].close);
      totalShares += pmt / price;
      totalInvested += pmt;
      installments += 1;
    }

    const firstPrice = Number(rows[0].close);
    const lastPrice = Number(rows[rows.length - 1].close);
    const finalValue = totalShares * lastPrice;
    const profit = finalValue - totalInvested;
    const dcaReturnPct = (profit / totalInvested) * 100;
    const lumpSumReturnPct = ((lastPrice - firstPrice) / firstPrice) * 100;
    const avgCost = totalInvested / totalShares;

    return {
      startDate: rows[0].date,
      endDate: rows[rows.length - 1].date,
      installments,
      totalInvested: round(totalInvested, 2),
      finalValue: round(finalValue, 2),
      profit: round(profit, 2),
      dcaReturnPct: round(dcaReturnPct, 2),
      lumpSumReturnPct: round(lumpSumReturnPct, 2),
      avgCost: round(avgCost, 4),
      lastPrice: round(lastPrice, 4),
    };
  }

  // Calculator 4: Risk-Based Position Sizing & Dividend DRIP Compounding
  function calculatePositionRisk({
    accountCapital = 200000,
    maxRiskPct = 1.5,
    entryPrice = 25,
    stopLossPrice = 22.8,
  } = {}) {
    const capital = finite(accountCapital, 0);
    const riskPct = finite(maxRiskPct, 0);
    const entry = finite(entryPrice, 0);
    const stop = finite(stopLossPrice, 0);
    if (capital <= 0 || riskPct <= 0 || entry <= 0 || stop <= 0 || stop >= entry) return null;

    const maxLossAmount = capital * (riskPct / 100);
    const perShareRisk = entry - stop;
    const stopDistancePct = (perShareRisk / entry) * 100;
    const rawShares = maxLossAmount / perShareRisk;
    const cappedByCapitalShares = capital / entry;
    const effectiveRaw = Math.min(rawShares, cappedByCapitalShares);
    const lotShares = Math.floor(effectiveRaw / 100) * 100;
    const positionValue = lotShares * entry;
    const positionWeightPct = (positionValue / capital) * 100;
    const actualRiskAmount = lotShares * perShareRisk;

    return {
      maxLossAmount: round(maxLossAmount, 2),
      perShareRisk: round(perShareRisk, 3),
      stopDistancePct: round(stopDistancePct, 2),
      recommendedShares: lotShares,
      positionValue: round(positionValue, 2),
      positionWeightPct: round(positionWeightPct, 2),
      actualRiskAmount: round(actualRiskAmount, 2),
      rMultipleTargets: [1.5, 2, 3].map(r => ({
        r,
        targetPrice: round(entry + perShareRisk * r, 3),
        gainPct: round(((perShareRisk * r) / entry) * 100, 2),
        estProfit: round(lotShares * perShareRisk * r, 2),
      })),
    };
  }

  function calculateDividendCompounding({
    initialPrincipal = 200000,
    annualContribution = 24000,
    dividendYieldPct = 5.0,
    priceGrowthPct = 3.0,
    years = 10,
    reinvest = true,
  } = {}) {
    const initial = finite(initialPrincipal, 0);
    const contrib = Math.max(0, finite(annualContribution, 0));
    const divYield = Math.max(0, finite(dividendYieldPct, 0)) / 100;
    const growth = finite(priceGrowthPct, 0) / 100;
    const yrs = Math.min(40, Math.max(1, Math.trunc(finite(years, 10))));
    if (initial <= 0) return null;

    let portfolio = initial;
    let cashDividendsCollected = 0;
    let totalContributed = initial;
    const schedule = [];

    for (let y = 1; y <= yrs; y += 1) {
      if (y > 1 && contrib > 0) {
        portfolio += contrib;
        totalContributed += contrib;
      }
      const annualDividend = portfolio * divYield;
      portfolio *= (1 + growth);
      if (reinvest) {
        portfolio += annualDividend;
      } else {
        cashDividendsCollected += annualDividend;
      }
      const totalWealth = portfolio + cashDividendsCollected;
      schedule.push({
        year: y,
        contributed: round(totalContributed, 2),
        annualDividend: round(annualDividend, 2),
        monthlyPassiveIncome: round(annualDividend / 12, 2),
        totalWealth: round(totalWealth, 2),
        yieldOnCostPct: round((annualDividend / totalContributed) * 100, 2),
      });
    }

    const last = schedule[schedule.length - 1];
    return {
      years: yrs,
      reinvest: Boolean(reinvest),
      totalContributed: last.contributed,
      finalWealth: last.totalWealth,
      finalAnnualDividend: last.annualDividend,
      finalMonthlyDividend: last.monthlyPassiveIncome,
      yieldOnCostPct: last.yieldOnCostPct,
      schedule,
    };
  }

  return {
    analyzePortfolio,
    backtestHistoricalDca,
    calculateCostDilution,
    calculateDividendCompounding,
    calculateGridPlan,
    calculatePositionRisk,
    classifyMarket,
    comparePortfolioWithBenchmark,
    simulateCompoundDca,
  };
});
