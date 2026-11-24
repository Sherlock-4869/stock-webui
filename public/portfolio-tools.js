/* Portfolio Deep Analytics, Trade Journal & Practical Investment Calculators */
(function () {
  'use strict';

  const TRADE_TAGS = ['趋势突破', '低估配置', '波段止盈', '纪律止损', '基本面拐点', '定投加仓', '题材试错'];

  const state = {
    tab: 'analytics', // 'analytics' | 'calculators'
    calcTab: 'cost', // 'cost' | 'grid' | 'dca' | 'risk'
    benchRange: 60,
    benchLoading: false,
    benchComparison: null,
    editingTradeIndex: null,
    dcaBacktestLoading: false,
    dcaBacktestResult: null,
  };

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function num(value, fallback = null) {
    if (value === '' || value == null) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmtMoney(value) {
    const n = num(value);
    if (n == null) return '--';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtSignedMoney(value) {
    const n = num(value);
    if (n == null) return '--';
    return `${n > 0 ? '+' : ''}${fmtMoney(n)}`;
  }

  function fmtPct(value) {
    const n = num(value);
    if (n == null) return '--';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  function tone(value) {
    const n = num(value);
    if (n == null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  }

  function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
  }

  function snapshot() {
    if (typeof window.InvestmentWorkbench?.getPortfolioSnapshot === 'function') {
      return window.InvestmentWorkbench.getPortfolioSnapshot();
    }
    return { positions: [], trades: [], quotes: {} };
  }

  async function fetchDailySeries(symbol) {
    const response = await fetch(`/api/kline?sym=${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error('K线获取失败');
    const payload = await response.json();
    const root = payload?.data?.[symbol] || Object.values(payload?.data || {})[0] || {};
    const key = Object.keys(root).find(k => /day$/i.test(k));
    const rows = Array.isArray(root[key]) ? root[key] : [];
    return rows.map(r => ({
      date: String(r?.[0] || '').slice(0, 10),
      close: num(r?.[2] ?? r?.[4] ?? r?.close, 0),
    })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.close > 0);
  }

  function drawBenchmarkCanvas(comparison) {
    const canvas = document.getElementById('pt-bench-canvas');
    const summaryEl = document.getElementById('pt-bench-summary');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, rect.width || 520);
    const h = 210;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const light = document.documentElement.dataset.theme === 'light';
    const gridColor = light ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.14)';
    const textColor = light ? '#64748b' : '#8b949e';

    if (!comparison || !comparison.points?.length) {
      ctx.fillStyle = textColor;
      ctx.font = '12px sans-serif';
      ctx.fillText(state.benchLoading ? '正在计算组合净值对比曲线…' : '添加模拟持仓后自动对比沪深 300 基准走势', 18, h / 2);
      if (summaryEl) summaryEl.textContent = '按当前持仓权重回溯近阶段表现，对比沪深 300 指数';
      return;
    }

    if (summaryEl) {
      summaryEl.innerHTML = `区间 <b>${esc(comparison.startDate)}</b> 至 <b>${esc(comparison.endDate)}</b>：组合 <b class="${tone(comparison.portfolioReturnPct)}">${esc(fmtPct(comparison.portfolioReturnPct))}</b> vs 沪深300 <b class="${tone(comparison.benchmarkReturnPct)}">${esc(fmtPct(comparison.benchmarkReturnPct))}</b> · 超额 Alpha <b class="${tone(comparison.alphaPct)}">${esc(fmtPct(comparison.alphaPct))}</b> · 最大回撤 <b class="down">-${comparison.maxDrawdownPct.toFixed(2)}%</b>`;
    }

    const pts = comparison.points;
    const allVals = pts.flatMap(p => [p.portfolioPct, p.benchmarkPct, 0]);
    const min = Math.min(...allVals) - 1;
    const max = Math.max(...allVals) + 1;
    const span = Math.max(0.5, max - min);
    const padL = 48, padR = 16, padT = 18, padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xFor = i => padL + (i / Math.max(1, pts.length - 1)) * plotW;
    const yFor = v => padT + ((max - v) / span) * plotH;

    ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= 3; i += 1) {
      const val = max - (span * i) / 3;
      const y = yFor(val);
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.textAlign = 'right';
      ctx.fillText(`${val >= 0 ? '+' : ''}${val.toFixed(1)}%`, padL - 6, y + 3);
    }

    const drawSeries = (key, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const x = xFor(idx), y = yFor(p[key]);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries('benchmarkPct', '#94a3b8', 1.6);
    drawSeries('portfolioPct', '#3b82f6', 2.4);

    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(pts[0].date, padL, h - 7);
    ctx.textAlign = 'right';
    ctx.fillText(pts[pts.length - 1].date, w - padR, h - 7);
  }

  async function loadBenchmarkComparison() {
    const calc = window.PortfolioCalculators;
    if (!calc || state.benchLoading) return;
    const snap = snapshot();
    const analysis = calc.analyzePortfolio(snap.positions, snap.trades, snap.quotes);
    const tradable = analysis.positions.filter(p => /^(?:sh|sz)\d{6}$/.test(p.symbol));
    if (!tradable.length) {
      state.benchComparison = null;
      drawBenchmarkCanvas(null);
      return;
    }
    state.benchLoading = true;
    drawBenchmarkCanvas(null);
    try {
      const [benchAll, ...posSeriesList] = await Promise.all([
        fetchDailySeries('sh000300'),
        ...tradable.map(p => fetchDailySeries(p.symbol).catch(() => [])),
      ]);
      const benchSliced = benchAll.slice(-state.benchRange);
      const seriesMap = {};
      const weightsMap = {};
      tradable.forEach((p, idx) => {
        if (posSeriesList[idx]?.length) {
          seriesMap[p.symbol] = posSeriesList[idx].slice(-state.benchRange);
          weightsMap[p.symbol] = p.marketValue || 1;
        }
      });
      state.benchComparison = calc.comparePortfolioWithBenchmark(seriesMap, weightsMap, benchSliced);
    } catch (_) {
      state.benchComparison = null;
    } finally {
      state.benchLoading = false;
      drawBenchmarkCanvas(state.benchComparison);
    }
  }

  function renderAnalytics() {
    const calc = window.PortfolioCalculators;
    if (!calc) return;
    const snap = snapshot();
    const stats = calc.analyzePortfolio(snap.positions, snap.trades, snap.quotes);

    const kpiEl = document.getElementById('pt-kpi-grid');
    if (kpiEl) {
      const pfText = stats.profitFactor == null ? '--' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
      kpiEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">持仓总市值</div><div class="metric-value">${stats.totalMarketValue ? fmtMoney(stats.totalMarketValue) : '--'}</div><div class="metric-note">投入成本 ${stats.totalCost ? fmtMoney(stats.totalCost) : '--'}</div></div>
        <div class="metric-card"><div class="metric-label">当前浮动盈亏</div><div class="metric-value ${tone(stats.unrealizedProfit)}">${stats.totalCost ? fmtSignedMoney(stats.unrealizedProfit) : '--'}</div><div class="metric-note">浮盈率 ${stats.unrealizedPct != null ? fmtPct(stats.unrealizedPct) : '--'}</div></div>
        <div class="metric-card"><div class="metric-label">累计已实现盈亏</div><div class="metric-value ${tone(stats.realizedProfit)}">${stats.closedCount ? fmtSignedMoney(stats.realizedProfit) : '0.00'}</div><div class="metric-note">已完成卖出 ${stats.closedCount} 笔</div></div>
        <div class="metric-card"><div class="metric-label">平仓胜率</div><div class="metric-value ${stats.winRatePct != null && stats.winRatePct >= 50 ? 'up' : ''}">${stats.winRatePct != null ? `${stats.winRatePct}%` : '--'}</div><div class="metric-note">${stats.winCount} 盈 / ${stats.lossCount} 亏</div></div>
        <div class="metric-card"><div class="metric-label">平均盈亏比</div><div class="metric-value">${esc(pfText)}</div><div class="metric-note">总盈亏 ${fmtSignedMoney(stats.totalProfit)}</div></div>
      `;
    }

    const allocEl = document.getElementById('pt-allocation-box');
    if (allocEl) {
      if (!stats.positions.length) {
        allocEl.innerHTML = '<div class="recap-empty-inline">当前暂无模拟持仓。可前往「投资工作台」或自选列表模拟买入。</div>';
      } else {
        const palette = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
        allocEl.innerHTML = `
          <div class="pt-alloc-bar">
            ${stats.marketAllocation.map((m, i) => `<span style="width:${Math.max(2, m.weightPct)}%;background:${palette[i % palette.length]}" title="${esc(m.label)} ${m.weightPct}%"></span>`).join('')}
          </div>
          <div class="pt-alloc-legend">
            ${stats.marketAllocation.map((m, i) => `<span class="pt-legend-item"><i style="background:${palette[i % palette.length]}"></i>${esc(m.label)} <b>${m.weightPct}%</b>（${fmtMoney(m.value)}）</span>`).join('')}
          </div>
          <div class="pt-pos-weights">
            ${stats.positions.slice(0, 8).map(p => `
              <div class="pt-weight-row">
                <div class="pt-weight-head"><span><strong>${esc(p.name)}</strong> <small>${esc(p.symbol)}</small></span><span>权重 <b>${p.weightPct}%</b> · <b class="${tone(p.returnPct)}">${fmtPct(p.returnPct)}</b></span></div>
                <div class="pt-weight-track"><span style="width:${Math.min(100, p.weightPct)}%"></span></div>
              </div>
            `).join('')}
          </div>
        `;
      }
    }

    const journalEl = document.getElementById('pt-journal-list');
    if (journalEl) {
      const rows = snap.trades.map((t, index) => ({ t, index })).sort((a, b) => (num(b.t.at, 0) - num(a.t.at, 0)) || b.index - a.index);
      if (!rows.length) {
        journalEl.innerHTML = '<div class="recap-empty-inline">暂无交易流水记录，记录模拟买卖后可在此补充买入逻辑、止损位和复盘标签。</div>';
      } else {
        journalEl.innerHTML = rows.map(({ t, index }) => {
          const isSell = String(t.side || '').toUpperCase() === 'SELL';
          const time = num(t.at, 0) > 0 ? new Date(Number(t.at)).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '--';
          const editing = state.editingTradeIndex === index;
          return `
            <div class="pt-journal-card">
              <div class="pt-journal-top">
                <div>
                  <span class="sm-tag ${isSell ? 'sm-tag-north' : 'sm-tag-warn'}">${isSell ? '卖出' : '买入'}</span>
                  <strong>${esc(t.name || t.symbol)}</strong>
                  <small>${esc(t.symbol)} · ${esc(time)}</small>
                  ${t.tag ? `<span class="sm-tag sm-tag-inst">${esc(t.tag)}</span>` : ''}
                </div>
                <div class="pt-journal-nums">
                  <span>数量 <b>${fmtMoney(t.quantity)}</b></span>
                  <span>成交价 <b>${num(t.price, 0).toFixed(3)}</b></span>
                  ${t.stopLoss ? `<span class="down">止损 ${num(t.stopLoss, 0).toFixed(2)}</span>` : ''}
                  ${t.takeProfit ? `<span class="up">止盈 ${num(t.takeProfit, 0).toFixed(2)}</span>` : ''}
                  <button class="sm-action-btn" type="button" onclick="PortfolioTools.toggleEditTrade(${index})">${editing ? '收起' : '复盘备注'}</button>
                </div>
              </div>
              ${t.note ? `<div class="pt-journal-note">📝 ${esc(t.note)}</div>` : ''}
              ${editing ? `
                <form class="pt-journal-editor" onsubmit="PortfolioTools.saveTradeMeta(event, ${index})">
                  <select class="form-select" name="tag">
                    <option value="">选择策略标签…</option>
                    ${TRADE_TAGS.map(tag => `<option value="${esc(tag)}"${t.tag === tag ? ' selected' : ''}>${esc(tag)}</option>`).join('')}
                  </select>
                  <input class="form-input" name="stopLoss" type="number" step="0.001" min="0" value="${t.stopLoss ?? ''}" placeholder="止损价（选填）">
                  <input class="form-input" name="takeProfit" type="number" step="0.001" min="0" value="${t.takeProfit ?? ''}" placeholder="止盈价（选填）">
                  <input class="form-input pt-journal-wide" name="note" maxlength="200" value="${esc(t.note || '')}" placeholder="记录买入逻辑、预期催化剂或事后复盘反思（最多200字）">
                  <button class="dialog-btn primary" type="submit">保存复盘</button>
                </form>
              ` : ''}
            </div>
          `;
        }).join('');
      }
    }

    loadBenchmarkComparison();
  }

  function toggleEditTrade(index) {
    state.editingTradeIndex = state.editingTradeIndex === index ? null : index;
    renderAnalytics();
  }

  function saveTradeMeta(event, index) {
    event.preventDefault();
    const form = new FormData(event.target);
    const ok = window.InvestmentWorkbench?.updateTradeMeta?.(index, {
      tag: form.get('tag'),
      stopLoss: form.get('stopLoss'),
      takeProfit: form.get('takeProfit'),
      note: form.get('note'),
    });
    if (ok) {
      state.editingTradeIndex = null;
      toast('交易复盘备注已保存');
      renderAnalytics();
    }
  }

  async function exportPortfolioNote() {
    const calc = window.PortfolioCalculators;
    if (!calc) return;
    const loggedIn = typeof window.isLoggedInUser === 'function' ? window.isLoggedInUser() : Boolean(window.currentUser);
    if (!loggedIn) {
      toast('请先登录后将组合复盘保存到个人笔记', true);
      if (typeof window.openAuthModal === 'function') window.openAuthModal('login');
      return;
    }
    const snap = snapshot();
    const stats = calc.analyzePortfolio(snap.positions, snap.trades, snap.quotes);
    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      `# 投资组合与交易复盘（${today}）`,
      '',
      '## 一、组合绩效概览',
      `- **持仓总市值**：${fmtMoney(stats.totalMarketValue)}（总成本 ${fmtMoney(stats.totalCost)}）`,
      `- **当前浮动盈亏**：${fmtSignedMoney(stats.unrealizedProfit)}（${stats.unrealizedPct != null ? fmtPct(stats.unrealizedPct) : '--'}）`,
      `- **累计已实现盈亏**：${fmtSignedMoney(stats.realizedProfit)}（平仓胜率 ${stats.winRatePct != null ? `${stats.winRatePct}%` : '--'}）`,
      '',
      '## 二、当前持仓结构',
      '| 标的 | 市场 | 数量 | 成本价 | 现价 | 仓位权重 | 浮动收益率 |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...stats.positions.map(p => `| ${p.name}(${p.symbol}) | ${p.marketLabel} | ${p.quantity} | ${p.cost.toFixed(3)} | ${p.price.toFixed(3)} | ${p.weightPct}% | ${fmtPct(p.returnPct)} |`),
      '',
      '## 三、近期交易复盘记录',
      ...snap.trades.slice(-15).reverse().map(t => {
        const side = String(t.side).toUpperCase() === 'SELL' ? '卖出' : '买入';
        const extras = [t.tag ? `[${t.tag}]` : '', t.stopLoss ? `止损:${t.stopLoss}` : '', t.note || ''].filter(Boolean).join(' — ');
        return `- **${side} ${t.name || t.symbol}**（${t.quantity}股 @ ${t.price}）${extras ? `：${extras}` : ''}`;
      }),
      '',
      '## 四、下阶段调整计划',
      '- 仓位与风控检视：',
      '- 重点跟踪催化剂：',
    ];
    try {
      const resp = await window.apiRequest('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: `组合与交易复盘 ${today}`, content: lines.join('\n') }),
      });
      toast('已生成组合复盘笔记');
      if (typeof window.switchAppPage === 'function') window.switchAppPage('notes');
      if (typeof window.loadNotesList === 'function') await window.loadNotesList({ reloadFolders: true });
      if (resp?.note?.id && typeof window.openNote === 'function') await window.openNote(resp.note.id);
    } catch (error) {
      toast(`保存笔记失败：${error.message || '请稍后重试'}`, true);
    }
  }

  // --- Calculators ---
  function runCostCalc(event) {
    if (event) event.preventDefault();
    const calc = window.PortfolioCalculators;
    const form = document.getElementById('pt-form-cost');
    const out = document.getElementById('pt-result-cost');
    if (!calc || !form || !out) return;
    const fd = new FormData(form);
    const res = calc.calculateCostDilution({
      currentShares: fd.get('currentShares'),
      currentCost: fd.get('currentCost'),
      buyPrice: fd.get('buyPrice'),
      addShares: fd.get('addShares'),
      targetCost: fd.get('targetCost'),
    });
    if (!res) { out.innerHTML = '<div class="recap-empty-inline">请输入有效的正数持仓数量、原成本价和拟补仓价格</div>'; return; }
    out.innerHTML = `
      ${res.warning ? `<div class="sm-unlock-alert" style="margin-bottom:10px">${esc(res.warning)}</div>` : ''}
      <div class="pt-calc-metrics">
        <div class="metric-card"><div class="metric-label">补仓后新成本</div><div class="metric-value">${res.newCost.toFixed(3)}</div><div class="metric-note">每股摊薄 ${res.costReduction >= 0 ? '-' : '+'}${Math.abs(res.costReduction).toFixed(3)} 元</div></div>
        <div class="metric-card"><div class="metric-label">需补仓股数 / 整手</div><div class="metric-value">${fmtMoney(res.addShares)}</div><div class="metric-note">按百股取整约 ${res.lotAlignedShares} 股</div></div>
        <div class="metric-card"><div class="metric-label">新增投入资金</div><div class="metric-value">${fmtMoney(res.addAmount)}</div><div class="metric-note">补仓后总投入 ${fmtMoney(res.totalInvested)}</div></div>
        <div class="metric-card"><div class="metric-label">回本所需涨幅</div><div class="metric-value ${tone(-res.reboundNeededAfterPct)}">${fmtPct(res.reboundNeededAfterPct)}</div><div class="metric-note">补仓前需涨 ${fmtPct(res.reboundNeededBeforePct)}</div></div>
      </div>
    `;
  }

  function runGridCalc(event) {
    if (event) event.preventDefault();
    const calc = window.PortfolioCalculators;
    const form = document.getElementById('pt-form-grid');
    const out = document.getElementById('pt-result-grid');
    if (!calc || !form || !out) return;
    const fd = new FormData(form);
    const res = calc.calculateGridPlan({
      lowerPrice: fd.get('lowerPrice'),
      upperPrice: fd.get('upperPrice'),
      gridCount: fd.get('gridCount'),
      perGridAmount: fd.get('perGridAmount'),
      mode: fd.get('mode'),
    });
    if (!res) { out.innerHTML = '<div class="recap-empty-inline">请确保区间上限大于区间下限，且每格投入金额大于 0</div>'; return; }
    out.innerHTML = `
      <div class="pt-calc-metrics">
        <div class="metric-card"><div class="metric-label">区间总振幅</div><div class="metric-value">${res.amplitudePct}%</div><div class="metric-note">${res.mode === 'geometric' ? '等比网格' : '等差网格'} · ${res.gridCount} 格</div></div>
        <div class="metric-card"><div class="metric-label">单格净收益率</div><div class="metric-value up">${res.minYieldPct}% ~ ${res.maxYieldPct}%</div><div class="metric-note">已扣除双边万三估算费率</div></div>
        <div class="metric-card"><div class="metric-label">极限满仓总资金</div><div class="metric-value">${fmtMoney(res.totalMaxCapital)}</div><div class="metric-note">累计持仓 ${res.totalMaxShares} 股</div></div>
      </div>
      <div class="limit-pool-table-wrap" style="margin-top:12px">
        <table class="limit-pool-table"><thead><tr><th>档位</th><th>买入触发价</th><th>卖出止盈价</th><th>整手股数</th><th>占用资金</th><th>单格预估净利</th><th>单格收益率</th></tr></thead>
        <tbody>${res.levels.map(l => `<tr><td>第 ${l.level} 格</td><td>${l.buyPrice.toFixed(3)}</td><td class="up">${l.sellPrice.toFixed(3)}</td><td>${l.shares} 股</td><td>${fmtMoney(l.capital)}</td><td class="up">+${fmtMoney(l.netProfit)}</td><td class="up">+${l.yieldPct.toFixed(2)}%</td></tr>`).join('')}</tbody></table>
      </div>
    `;
  }

  async function runDcaCalc(event) {
    if (event) event.preventDefault();
    const calc = window.PortfolioCalculators;
    const form = document.getElementById('pt-form-dca');
    const out = document.getElementById('pt-result-dca');
    if (!calc || !form || !out) return;
    const fd = new FormData(form);
    const comp = calc.simulateCompoundDca({
      periodicAmount: fd.get('periodicAmount'),
      periodsPerYear: fd.get('periodsPerYear'),
      annualReturnPct: fd.get('annualReturnPct'),
      years: fd.get('years'),
    });
    const rawSym = String(fd.get('backtestSymbol') || '').trim().toLowerCase();
    let histHtml = '';
    if (rawSym) {
      const sym = /^\d{6}$/.test(rawSym) ? (/^[56]/.test(rawSym) ? `sh${rawSym}` : `sz${rawSym}`) : rawSym;
      try {
        const rows = await fetchDailySeries(sym);
        const intervalSessions = Number(fd.get('periodsPerYear')) === 52 ? 5 : Number(fd.get('periodsPerYear')) === 26 ? 10 : 20;
        const bt = calc.backtestHistoricalDca(rows, { periodicAmount: fd.get('periodicAmount'), intervalSessions });
        if (bt) {
          histHtml = `
            <div class="module-panel" style="padding:14px;margin-bottom:14px">
              <strong style="font-size:13px">📊 ${esc(sym)} 近一年真实日线定投回测（${esc(bt.startDate)} 至 ${esc(bt.endDate)}，定投 ${bt.installments} 期）</strong>
              <div class="pt-calc-metrics" style="margin-top:10px">
                <div class="metric-card"><div class="metric-label">累计定投本金</div><div class="metric-value">${fmtMoney(bt.totalInvested)}</div><div class="metric-note">定投均价 ${bt.avgCost.toFixed(3)}（现价 ${bt.lastPrice.toFixed(3)}）</div></div>
                <div class="metric-card"><div class="metric-label">期末持仓市值</div><div class="metric-value ${tone(bt.profit)}">${fmtMoney(bt.finalValue)}</div><div class="metric-note">定投盈亏 ${fmtSignedMoney(bt.profit)}</div></div>
                <div class="metric-card"><div class="metric-label">定投总收益率</div><div class="metric-value ${tone(bt.dcaReturnPct)}">${fmtPct(bt.dcaReturnPct)}</div><div class="metric-note">同期一次性买入 ${fmtPct(bt.lumpSumReturnPct)}</div></div>
              </div>
            </div>
          `;
        }
      } catch (_) {
        histHtml = `<div class="sm-unlock-alert" style="margin-bottom:12px">未能读取 ${esc(sym)} 的历史日K线（请使用如 sh510300、sz159915、sh600519 格式）。</div>`;
      }
    }
    if (!comp) { out.innerHTML = histHtml || '<div class="recap-empty-inline">请输入有效的定投参数</div>'; return; }
    out.innerHTML = `
      ${histHtml}
      <div class="pt-calc-metrics">
        <div class="metric-card"><div class="metric-label">累计投入本金</div><div class="metric-value">${fmtMoney(comp.principal)}</div><div class="metric-note">共定投 ${comp.totalPeriods} 期</div></div>
        <div class="metric-card"><div class="metric-label">复利期末总资产</div><div class="metric-value up">${fmtMoney(comp.finalBalance)}</div><div class="metric-note">总收益率 ${fmtPct(comp.totalReturnPct)}</div></div>
        <div class="metric-card"><div class="metric-label">复利投资收益</div><div class="metric-value up">+${fmtMoney(comp.totalProfit)}</div><div class="metric-note">收益占期末 ${(comp.totalProfit / comp.finalBalance * 100).toFixed(1)}%</div></div>
      </div>
      <div class="limit-pool-table-wrap" style="margin-top:12px">
        <table class="limit-pool-table"><thead><tr><th>年度</th><th>累计本金</th><th>期末总资产</th><th>累计投资收益</th><th>累计收益率</th></tr></thead>
        <tbody>${comp.yearly.map(y => `<tr><td>第 ${y.year} 年</td><td>${fmtMoney(y.principal)}</td><td><strong>${fmtMoney(y.balance)}</strong></td><td class="${tone(y.profit)}">${fmtSignedMoney(y.profit)}</td><td class="${tone(y.returnPct)}">${fmtPct(y.returnPct)}</td></tr>`).join('')}</tbody></table>
      </div>
    `;
  }

  function runRiskAndDividendCalc(event) {
    if (event) event.preventDefault();
    const calc = window.PortfolioCalculators;
    const riskForm = document.getElementById('pt-form-risk');
    const divForm = document.getElementById('pt-form-dividend');
    const riskOut = document.getElementById('pt-result-risk');
    const divOut = document.getElementById('pt-result-dividend');
    if (!calc) return;

    if (riskForm && riskOut) {
      const fd = new FormData(riskForm);
      const r = calc.calculatePositionRisk({
        accountCapital: fd.get('accountCapital'),
        maxRiskPct: fd.get('maxRiskPct'),
        entryPrice: fd.get('entryPrice'),
        stopLossPrice: fd.get('stopLossPrice'),
      });
      if (!r) {
        riskOut.innerHTML = '<div class="recap-empty-inline">请确保计划止损价低于计划买入价，且资金大于 0</div>';
      } else {
        riskOut.innerHTML = `
          <div class="pt-calc-metrics">
            <div class="metric-card"><div class="metric-label">建议买入上限（整手）</div><div class="metric-value">${r.recommendedShares} 股</div><div class="metric-note">对应市值 ${fmtMoney(r.positionValue)}（仓位 ${r.positionWeightPct}%）</div></div>
            <div class="metric-card"><div class="metric-label">触发止损实际亏损</div><div class="metric-value down">-${fmtMoney(r.actualRiskAmount)}</div><div class="metric-note">止损幅度 -${r.stopDistancePct}%（风控上限 ${fmtMoney(r.maxLossAmount)}）</div></div>
          </div>
          <div class="pt-r-targets">${r.rMultipleTargets.map(t => `<span class="recap-theme-chip">${t.r}R 止盈目标：<b>${t.targetPrice.toFixed(2)}</b>（+${t.gainPct}% / +${fmtMoney(t.estProfit)}）</span>`).join('')}</div>
        `;
      }
    }

    if (divForm && divOut) {
      const fd = new FormData(divForm);
      const d = calc.calculateDividendCompounding({
        initialPrincipal: fd.get('initialPrincipal'),
        annualContribution: fd.get('annualContribution'),
        dividendYieldPct: fd.get('dividendYieldPct'),
        priceGrowthPct: fd.get('priceGrowthPct'),
        years: fd.get('years'),
        reinvest: fd.get('reinvest') === 'on',
      });
      if (!d) {
        divOut.innerHTML = '<div class="recap-empty-inline">请输入有效的初始本金与股息率</div>';
      } else {
        divOut.innerHTML = `
          <div class="pt-calc-metrics">
            <div class="metric-card"><div class="metric-label">第 ${d.years} 年期末总资产</div><div class="metric-value up">${fmtMoney(d.finalWealth)}</div><div class="metric-note">累计投入本金 ${fmtMoney(d.totalContributed)}</div></div>
            <div class="metric-card"><div class="metric-label">第 ${d.years} 年年度分红现金流</div><div class="metric-value up">${fmtMoney(d.finalAnnualDividend)}</div><div class="metric-note">折合月均被动收入 ${fmtMoney(d.finalMonthlyDividend)}（成本股息率 ${d.yieldOnCostPct}%）</div></div>
          </div>
          <div class="limit-pool-table-wrap" style="margin-top:10px;max-height:240px">
            <table class="limit-pool-table"><thead><tr><th>年份</th><th>累计投入</th><th>当年分红</th><th>折合月均分红</th><th>期末总资产</th><th>对本金股息率</th></tr></thead>
            <tbody>${d.schedule.map(s => `<tr><td>第 ${s.year} 年</td><td>${fmtMoney(s.contributed)}</td><td class="up">${fmtMoney(s.annualDividend)}</td><td>${fmtMoney(s.monthlyPassiveIncome)}</td><td><strong>${fmtMoney(s.totalWealth)}</strong></td><td>${s.yieldOnCostPct}%</td></tr>`).join('')}</tbody></table>
          </div>
        `;
      }
    }
  }

  function setTab(tab) {
    if (!['analytics', 'calculators'].includes(tab)) return;
    state.tab = tab;
    document.querySelectorAll('[data-pt-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.ptTab === tab));
    document.querySelectorAll('[data-pt-panel]').forEach(p => { p.hidden = p.dataset.ptPanel !== tab; });
    if (tab === 'analytics') renderAnalytics();
    else {
      runCostCalc();
      runGridCalc();
      runDcaCalc();
      runRiskAndDividendCalc();
    }
  }

  function setCalcTab(calcTab) {
    if (!['cost', 'grid', 'dca', 'risk'].includes(calcTab)) return;
    state.calcTab = calcTab;
    document.querySelectorAll('[data-pt-calc]').forEach(btn => btn.classList.toggle('active', btn.dataset.ptCalc === calcTab));
    document.querySelectorAll('[data-pt-calc-panel]').forEach(p => { p.hidden = p.dataset.ptCalcPanel !== calcTab; });
  }

  function setBenchRange(days) {
    const n = Number(days);
    if (![30, 60, 120].includes(n)) return;
    state.benchRange = n;
    document.querySelectorAll('[data-pt-bench]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.ptBench) === n));
    loadBenchmarkComparison();
  }

  function load() {
    setTab(state.tab);
  }

  window.addEventListener('resize', () => {
    if (document.getElementById('page-portfolio-tools')?.classList.contains('active') && state.tab === 'analytics') {
      drawBenchmarkCanvas(state.benchComparison);
    }
  });

  window.PortfolioTools = {
    load,
    setTab,
    setCalcTab,
    setBenchRange,
    toggleEditTrade,
    saveTradeMeta,
    exportPortfolioNote,
    runCostCalc,
    runGridCalc,
    runDcaCalc,
    runRiskAndDividendCalc,
  };
})();
