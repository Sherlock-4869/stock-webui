/* Smart Money & Dragon-Tiger Board page: LHB + seats, Margin Trading trend/ranking, and Restricted Share Unlocks. */
(function () {
  'use strict';

  const state = {
    tab:'lhb',
    lhb:{
      loaded:false,
      loading:false,
      requestId:0,
      payload:null,
      date:'',
      filter:'all',
      query:'',
      selectedKey:'',
      seatsCache:{},
      seatsLoading:false,
      seatsError:'',
    },
    margin:{
      loaded:false,
      loading:false,
      requestId:0,
      payload:null,
      sort:'netBuy',
      onlyTracked:false,
      query:'',
    },
    unlock:{
      loaded:false,
      loading:false,
      requestId:0,
      payload:null,
      days:30,
      filter:'all',
      query:'',
    },
  };

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function num(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function fmtPct(value) {
    const n = num(value);
    return n == null ? '--' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  function fmtPrice(value) {
    const n = num(value);
    return n == null ? '--' : n.toFixed(2);
  }

  function fmtSignedMoney(value) {
    const n = num(value);
    if (n == null) return '--';
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`;
    return `${sign}${Math.round(abs).toLocaleString('zh-CN')}`;
  }

  function fmtPlainMoney(value) {
    const n = num(value);
    if (n == null) return '--';
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
    return Math.round(n).toLocaleString('zh-CN');
  }

  function fmtShares(value) {
    const n = num(value);
    if (n == null) return '--';
    if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿股`;
    if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万股`;
    return `${Math.round(n).toLocaleString('zh-CN')}股`;
  }

  function tone(value) {
    const n = num(value);
    if (n == null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  }

  function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
  }

  function getTrackedSets() {
    if (typeof window.getTrackedStockInfo === 'function') {
      return window.getTrackedStockInfo();
    }
    return { watchlistCodes:new Set(), positionCodes:new Set() };
  }

  function trackedBadges(code) {
    const { watchlistCodes, positionCodes } = getTrackedSets();
    const badges = [];
    if (positionCodes.has(code)) badges.push('<span class="sm-tag sm-tag-pos">持仓</span>');
    if (watchlistCodes.has(code)) badges.push('<span class="sm-tag sm-tag-watch">自选</span>');
    return badges.join('');
  }

  function isTracked(code) {
    const { watchlistCodes, positionCodes } = getTrackedSets();
    return positionCodes.has(code) || watchlistCodes.has(code);
  }

  function openStock(symbol, name, price, pct) {
    if (!symbol) return;
    if (typeof window.openMarketStockPreview === 'function') {
      window.openMarketStockPreview({ symbol, name, price, pct });
    } else if (typeof window.openModal === 'function') {
      window.openModal(symbol);
    }
  }

  function addUnlockToWorkbench(date, name, code, ratioPct) {
    const title = `${name}(${code}) 限售解禁${ratioPct != null ? ` · 占总股本${ratioPct}%` : ''}`;
    if (typeof window.addWorkbenchEventQuick === 'function') {
      const added = window.addWorkbenchEventQuick({ date, title, kind:'解禁' });
      if (added) {
        toast(`已将「${title}」加入投资工作台事件日历`);
        return;
      }
    }
    toast('无法写入投资工作台事件，请稍后重试', true);
  }

  // --- LHB (Dragon-Tiger Board) ---
  function renderLhb() {
    const data = state.lhb.payload;
    const summaryEl = document.getElementById('sm-lhb-summary');
    const tableEl = document.getElementById('sm-lhb-table');
    const statusEl = document.getElementById('sm-lhb-status');
    const dateInput = document.getElementById('sm-lhb-date');
    if (!data) return;

    if (dateInput && !dateInput.value && data.tradeDate) dateInput.value = data.tradeDate;
    if (statusEl) {
      const updated = num(data.fetchedAt)
        ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })
        : '刚刚';
      statusEl.textContent = `上榜日 ${data.tradeDate || '--'} · ${updated} 更新${data.partial ? '（部分数据降级）' : ''}`;
    }

    const summary = data.summary || {};
    const instRows = Array.isArray(data.institutions) ? data.institutions : [];
    const instNetBuyCount = instRows.filter(item => num(item.netAmount) > 0).length;
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">上榜个股</div><div class="metric-value">${summary.totalCount ?? 0}</div><div class="metric-note">交易日 ${esc(data.tradeDate || '--')}</div></div>
        <div class="metric-card"><div class="metric-label">龙虎榜净买入</div><div class="metric-value ${tone(summary.totalNetBuy)}">${esc(fmtSignedMoney(summary.totalNetBuy))}</div><div class="metric-note">净买 ${summary.netBuyCount ?? 0} 家 · 净卖 ${summary.netSellCount ?? 0} 家</div></div>
        <div class="metric-card"><div class="metric-label">机构上榜</div><div class="metric-value">${instRows.length}</div><div class="metric-note">机构净买入 ${instNetBuyCount} 家</div></div>
      `;
    }

    if (!tableEl) return;
    const q = state.lhb.query.trim().toLowerCase();
    const isInstView = state.lhb.filter === 'institution';
    let rows = isInstView ? instRows : (Array.isArray(data.stocks) ? data.stocks : []);
    if (state.lhb.filter === 'tracked') rows = rows.filter(r => isTracked(r.code));
    if (q) {
      rows = rows.filter(r => `${r.code} ${r.name} ${(r.reasons || [r.reason || '']).join(' ')}`.toLowerCase().includes(q));
    }

    if (!rows.length) {
      tableEl.innerHTML = `<div class="recap-empty-inline">${state.lhb.filter === 'tracked' ? '当前交易日自选与持仓股未上龙虎榜' : '当前日期暂无符合条件的龙虎榜记录'}</div>`;
      return;
    }

    if (isInstView) {
      tableEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>股票</th><th>收盘价</th><th>涨跌幅</th><th>机构净买入</th><th>机构买入</th><th>机构卖出</th><th>买/卖机构数</th><th>上榜原因</th><th>操作</th></tr></thead><tbody>${rows.map(r => {
        const key = `${r.tradeDate}:${r.code}`;
        const active = state.lhb.selectedKey === key ? ' class="sm-row-active"' : '';
        return `<tr${active}>
          <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="SmartMoney.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.closePrice) ?? 'null'},${num(r.pct) ?? 'null'})">${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></span>`}</td>
          <td>${esc(fmtPrice(r.closePrice))}</td>
          <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
          <td class="${tone(r.netAmount)}"><strong>${esc(fmtSignedMoney(r.netAmount))}</strong></td>
          <td>${esc(fmtPlainMoney(r.buyAmount))}</td>
          <td>${esc(fmtPlainMoney(r.sellAmount))}</td>
          <td>${num(r.buyOrgCount) ?? '--'} / ${num(r.sellOrgCount) ?? '--'}</td>
          <td class="sm-reason-cell" title="${esc(r.reason || '')}">${esc(r.reason || '--')}</td>
          <td><button class="sm-action-btn" type="button" onclick="SmartMoney.inspectSeats('${esc(r.code)}','${esc(r.tradeDate)}','${esc(r.name)}')">席位</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
      return;
    }

    tableEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>股票</th><th>收盘价</th><th>涨跌幅</th><th>换手率</th><th>龙虎榜净买</th><th>买入总额</th><th>卖出总额</th><th>上榜原因</th><th>操作</th></tr></thead><tbody>${rows.map(r => {
      const key = `${r.tradeDate}:${r.code}`;
      const active = state.lhb.selectedKey === key ? ' class="sm-row-active"' : '';
      const reasonText = (r.reasons || []).join('；') || '--';
      return `<tr${active}>
        <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="SmartMoney.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.closePrice) ?? 'null'},${num(r.pct) ?? 'null'})">${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></span>`}</td>
        <td>${esc(fmtPrice(r.closePrice))}</td>
        <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
        <td>${num(r.turnoverRate) != null ? `${r.turnoverRate.toFixed(2)}%` : '--'}</td>
        <td class="${tone(r.netAmount)}"><strong>${esc(fmtSignedMoney(r.netAmount))}</strong></td>
        <td>${esc(fmtPlainMoney(r.buyAmount))}</td>
        <td>${esc(fmtPlainMoney(r.sellAmount))}</td>
        <td class="sm-reason-cell" title="${esc(reasonText)}">${esc(reasonText)}</td>
        <td><button class="sm-action-btn" type="button" onclick="SmartMoney.inspectSeats('${esc(r.code)}','${esc(r.tradeDate)}','${esc(r.name)}')">席位</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  }

  function renderSeatsPanel(meta = null) {
    const panel = document.getElementById('sm-seats-panel');
    if (!panel) return;
    if (!state.lhb.selectedKey) {
      panel.innerHTML = '<div class="recap-empty-inline">点击上方任意上榜个股的「席位」按钮，查看买卖前五营业部与机构专用席位明细。</div>';
      return;
    }
    if (state.lhb.seatsLoading) {
      panel.innerHTML = '<div class="module-loading">正在加载营业部与机构席位明细</div>';
      return;
    }
    if (state.lhb.seatsError) {
      panel.innerHTML = `<div class="recap-empty-inline">${esc(state.lhb.seatsError)}</div>`;
      return;
    }
    const detail = state.lhb.seatsCache[state.lhb.selectedKey];
    if (!detail) return;
    const inst = detail.institutionSummary || {};
    const renderList = (seats, side) => {
      if (!seats?.length) return '<div class="recap-empty-inline">暂无席位记录</div>';
      return seats.map((s, idx) => `
        <div class="sm-seat-row">
          <div class="sm-seat-name">
            <span class="sm-seat-rank">${idx + 1}</span>
            <span>${esc(s.deptName)}</span>
            ${s.isInstitution ? '<span class="sm-tag sm-tag-inst">机构专用</span>' : ''}
            ${s.isNorthbound ? '<span class="sm-tag sm-tag-north">陆股通</span>' : ''}
          </div>
          <div class="sm-seat-nums">
            <span class="up">买 ${esc(fmtPlainMoney(s.buyAmount))}</span>
            <span class="down">卖 ${esc(fmtPlainMoney(s.sellAmount))}</span>
            <strong class="${tone(s.netAmount)}">净 ${esc(fmtSignedMoney(s.netAmount))}</strong>
          </div>
        </div>
      `).join('');
    };
    panel.innerHTML = `
      <div class="sm-seats-head">
        <div>
          <strong>${esc(meta?.name || detail.code)}（${esc(detail.code)}）· ${esc(detail.tradeDate)} 席位明细</strong>
          <small>机构买席 ${inst.buyCount || 0} 家 / 卖席 ${inst.sellCount || 0} 家 · 机构净额 <b class="${tone(inst.netAmount)}">${esc(fmtSignedMoney(inst.netAmount))}</b></small>
        </div>
      </div>
      <div class="sm-seats-grid">
        <div class="sm-seats-col"><h4 class="up">买入前五营业部</h4>${renderList(detail.buySeats, 'buy')}</div>
        <div class="sm-seats-col"><h4 class="down">卖出前五营业部</h4>${renderList(detail.sellSeats, 'sell')}</div>
      </div>
    `;
  }

  async function inspectSeats(code, date, name) {
    const key = `${date}:${code}`;
    state.lhb.selectedKey = key;
    state.lhb.seatsError = '';
    renderLhb();
    if (state.lhb.seatsCache[key]) {
      renderSeatsPanel({ name });
      return;
    }
    state.lhb.seatsLoading = true;
    renderSeatsPanel({ name });
    try {
      const response = await fetch(`/api/smart-money/lhb-seats?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '席位明细获取失败');
      state.lhb.seatsCache[key] = payload;
    } catch (error) {
      state.lhb.seatsError = error.message || '席位明细暂时不可用';
    } finally {
      state.lhb.seatsLoading = false;
      renderSeatsPanel({ name });
    }
  }

  async function loadLhb(force = false) {
    if (state.lhb.loading && !force) return;
    const requestId = ++state.lhb.requestId;
    state.lhb.loading = true;
    const statusEl = document.getElementById('sm-lhb-status');
    const tableEl = document.getElementById('sm-lhb-table');
    if (statusEl) statusEl.textContent = '正在同步龙虎榜数据…';
    if (!state.lhb.payload || force) {
      if (tableEl) tableEl.innerHTML = '<div class="module-loading">正在同步龙虎榜数据</div>';
    }
    try {
      const qs = new URLSearchParams();
      if (state.lhb.date) qs.set('date', state.lhb.date);
      if (force) qs.set('refresh', '1');
      const response = await fetch(`/api/smart-money/lhb${qs.toString() ? `?${qs}` : ''}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '龙虎榜数据加载失败');
      if (requestId !== state.lhb.requestId) return;
      state.lhb.payload = payload;
      state.lhb.loaded = true;
      renderLhb();
      renderSeatsPanel();
    } catch (error) {
      if (requestId !== state.lhb.requestId) return;
      if (statusEl) statusEl.textContent = error.message || '龙虎榜暂时不可用';
      if (tableEl) tableEl.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}<br><button class="refresh-btn" type="button" onclick="SmartMoney.refreshActive()">重新获取</button></div>`;
    } finally {
      if (requestId === state.lhb.requestId) state.lhb.loading = false;
    }
  }

  // --- Margin Trading ---
  function marginTrendSvg(series) {
    if (!Array.isArray(series) || series.length < 2) {
      return '<div class="recap-empty-inline">暂无足够的两融趋势序列</div>';
    }
    const values = series.map(p => num(p.totalBalance)).filter(v => v != null);
    if (values.length < 2) return '<div class="recap-empty-inline">两融趋势数据缺失</div>';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const w = 720;
    const h = 160;
    const padX = 16;
    const padY = 18;
    const points = series.map((p, idx) => {
      const x = padX + idx * (w - padX * 2) / Math.max(1, series.length - 1);
      const y = h - padY - ((num(p.totalBalance) - min) / span) * (h - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const areaPoints = `${padX},${h - padY} ${points.join(' ')} ${(w - padX).toFixed(1)},${h - padY}`;
    const firstDate = series[0].date;
    const lastDate = series[series.length - 1].date;
    return `
      <svg class="sm-margin-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="两市融资融券余额趋势图">
        <polygon points="${areaPoints}" fill="#58a6ff1f"></polygon>
        <polyline points="${points.join(' ')}" fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>
      </svg>
      <div class="sm-margin-axis">
        <span>${esc(firstDate)}</span>
        <span>区间低点 ${esc(fmtPlainMoney(min))} · 高点 ${esc(fmtPlainMoney(max))}</span>
        <span>${esc(lastDate)}</span>
      </div>
    `;
  }

  function renderMargin() {
    const data = state.margin.payload;
    if (!data) return;
    const summaryEl = document.getElementById('sm-margin-summary');
    const chartEl = document.getElementById('sm-margin-chart');
    const tableEl = document.getElementById('sm-margin-table');
    const statusEl = document.getElementById('sm-margin-status');
    const latest = data.market?.latest || null;

    if (statusEl) {
      statusEl.textContent = `数据日期 ${data.tradeDate || '--'} · 两融数据于交易日次晨披露${data.partial ? '（部分降级）' : ''}`;
    }
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">两市两融余额</div><div class="metric-value">${esc(fmtPlainMoney(latest?.totalBalance))}</div><div class="metric-note ${tone(latest?.balanceDelta)}">较前日 ${esc(fmtSignedMoney(latest?.balanceDelta))}</div></div>
        <div class="metric-card"><div class="metric-label">融资余额</div><div class="metric-value">${esc(fmtPlainMoney(latest?.rzBalance))}</div><div class="metric-note ${tone(latest?.rzBalanceDelta)}">较前日 ${esc(fmtSignedMoney(latest?.rzBalanceDelta))}</div></div>
        <div class="metric-card"><div class="metric-label">当日融资净买入</div><div class="metric-value ${tone(latest?.rzNetBuy)}">${esc(fmtSignedMoney(latest?.rzNetBuy))}</div><div class="metric-note">买入 ${esc(fmtPlainMoney(latest?.rzBuy))} · 偿还 ${esc(fmtPlainMoney(latest?.rzRepay))}</div></div>
        <div class="metric-card"><div class="metric-label">融券余额</div><div class="metric-value">${esc(fmtPlainMoney(latest?.rqBalance))}</div><div class="metric-note">最新日期 ${esc(latest?.date || '--')}</div></div>
      `;
    }
    if (chartEl) chartEl.innerHTML = marginTrendSvg(data.market?.series || []);
    if (!tableEl) return;

    const q = state.margin.query.trim().toLowerCase();
    let rows = Array.isArray(data.stocks) ? data.stocks : [];
    if (state.margin.onlyTracked) rows = rows.filter(r => isTracked(r.code));
    if (q) rows = rows.filter(r => `${r.code} ${r.name}`.toLowerCase().includes(q));

    if (!rows.length) {
      tableEl.innerHTML = '<div class="recap-empty-inline">暂无匹配的个股两融排行数据</div>';
      return;
    }
    tableEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>排名</th><th>股票</th><th>收盘价</th><th>涨跌幅</th><th>融资净买入</th><th>融资买入额</th><th>融资余额</th><th>融券余额</th></tr></thead><tbody>${rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="SmartMoney.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.closePrice) ?? 'null'},${num(r.pct) ?? 'null'})">${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></span>`}</td>
        <td>${esc(fmtPrice(r.closePrice))}</td>
        <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
        <td class="${tone(r.rzNetBuy)}"><strong>${esc(fmtSignedMoney(r.rzNetBuy))}</strong></td>
        <td>${esc(fmtPlainMoney(r.rzBuy))}</td>
        <td>${esc(fmtPlainMoney(r.rzBalance))}</td>
        <td>${esc(fmtPlainMoney(r.rqBalance))}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  async function loadMargin(force = false) {
    if (state.margin.loading && !force) return;
    const requestId = ++state.margin.requestId;
    state.margin.loading = true;
    const statusEl = document.getElementById('sm-margin-status');
    const tableEl = document.getElementById('sm-margin-table');
    if (statusEl) statusEl.textContent = '正在同步融资融券数据…';
    if (!state.margin.payload || force) {
      if (tableEl) tableEl.innerHTML = '<div class="module-loading">正在同步融资融券数据</div>';
    }
    try {
      const qs = new URLSearchParams({ sort:state.margin.sort });
      if (force) qs.set('refresh', '1');
      const response = await fetch(`/api/smart-money/margin?${qs}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '融资融券加载失败');
      if (requestId !== state.margin.requestId) return;
      state.margin.payload = payload;
      state.margin.loaded = true;
      renderMargin();
    } catch (error) {
      if (requestId !== state.margin.requestId) return;
      if (statusEl) statusEl.textContent = error.message || '两融数据暂时不可用';
      if (tableEl) tableEl.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}<br><button class="refresh-btn" type="button" onclick="SmartMoney.refreshActive()">重新获取</button></div>`;
    } finally {
      if (requestId === state.margin.requestId) state.margin.loading = false;
    }
  }

  // --- Restricted Share Unlocks ---
  function renderUnlock() {
    const data = state.unlock.payload;
    if (!data) return;
    const summaryEl = document.getElementById('sm-unlock-summary');
    const alertEl = document.getElementById('sm-unlock-alert');
    const tableEl = document.getElementById('sm-unlock-table');
    const statusEl = document.getElementById('sm-unlock-status');
    const summary = data.summary || {};
    const allRows = Array.isArray(data.data) ? data.data : [];
    const trackedHits = allRows.filter(r => isTracked(r.code));

    if (statusEl) {
      statusEl.textContent = `区间 ${data.startDate || '--'} 至 ${data.endDate || '--'} · 共 ${allRows.length} 笔解禁计划`;
    }
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">未来 ${data.days} 天解禁</div><div class="metric-value">${summary.totalCount ?? 0}</div><div class="metric-note">其中未来 7 天 ${summary.next7DaysCount ?? 0} 笔</div></div>
        <div class="metric-card"><div class="metric-label">参考解禁市值</div><div class="metric-value">${esc(fmtPlainMoney(summary.totalMarketCap))}</div><div class="metric-note">按最新价估算</div></div>
        <div class="metric-card"><div class="metric-label">大额/高比例解禁</div><div class="metric-value down">${summary.highPressureCount ?? 0}</div><div class="metric-note">占总股本 ≥10% 或市值 ≥20亿</div></div>
        <div class="metric-card"><div class="metric-label">自选/持仓命中</div><div class="metric-value ${trackedHits.length ? 'down' : ''}">${trackedHits.length}</div><div class="metric-note">${trackedHits.length ? '建议重点关注解禁日' : '当前区间无命中标的'}</div></div>
      `;
    }
    if (alertEl) {
      if (trackedHits.length) {
        alertEl.hidden = false;
        alertEl.innerHTML = `<strong>解禁风险提示：</strong>您的自选或模拟持仓中有 <b>${trackedHits.length}</b> 只股票在未来 ${data.days} 天面临限售解禁：${trackedHits.slice(0, 6).map(r => `${esc(r.name)}(${esc(r.freeDate)})`).join('、')}${trackedHits.length > 6 ? ' 等' : ''}。`;
      } else {
        alertEl.hidden = true;
        alertEl.innerHTML = '';
      }
    }
    if (!tableEl) return;

    const q = state.unlock.query.trim().toLowerCase();
    let rows = allRows;
    if (state.unlock.filter === 'tracked') rows = rows.filter(r => isTracked(r.code));
    else if (state.unlock.filter === 'high') rows = rows.filter(r => Number(r.totalRatioPct) >= 10 || Number(r.liftMarketCap) >= 2e9);
    if (q) rows = rows.filter(r => `${r.code} ${r.name} ${r.shareType}`.toLowerCase().includes(q));

    if (!rows.length) {
      tableEl.innerHTML = `<div class="recap-empty-inline">${state.unlock.filter === 'tracked' ? '未来区间内自选与持仓暂无限售解禁' : '暂无符合条件的限售解禁计划'}</div>`;
      return;
    }

    tableEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>解禁日期</th><th>股票</th><th>股份类型</th><th>解禁股数</th><th>实际可流通</th><th>参考解禁市值</th><th>占总股本</th><th>操作</th></tr></thead><tbody>${rows.map(r => {
      const high = Number(r.totalRatioPct) >= 10 || Number(r.liftMarketCap) >= 2e9;
      return `<tr>
        <td>${esc(r.freeDate)}</td>
        <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="SmartMoney.openStock('${esc(r.symbol)}','${esc(r.name)}',null,null)">${esc(r.name)} ${trackedBadges(r.code)}${high ? '<span class="sm-tag sm-tag-warn">大额</span>' : ''}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)} ${trackedBadges(r.code)}<small>${esc(r.code)}</small></span>`}</td>
        <td>${esc(r.shareType)}</td>
        <td>${esc(fmtShares(r.freeShares))}</td>
        <td>${esc(fmtShares(r.ableFreeShares))}</td>
        <td class="${high ? 'down' : ''}"><strong>${esc(fmtPlainMoney(r.liftMarketCap))}</strong></td>
        <td class="${Number(r.totalRatioPct) >= 10 ? 'down' : ''}">${r.totalRatioPct != null ? `${r.totalRatioPct.toFixed(2)}%` : '--'}</td>
        <td><button class="sm-action-btn" type="button" onclick="SmartMoney.addUnlockToWorkbench('${esc(r.freeDate)}','${esc(r.name)}','${esc(r.code)}',${r.totalRatioPct ?? 'null'})">+ 日历</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  }

  async function loadUnlock(force = false) {
    if (state.unlock.loading && !force) return;
    const requestId = ++state.unlock.requestId;
    state.unlock.loading = true;
    const statusEl = document.getElementById('sm-unlock-status');
    const tableEl = document.getElementById('sm-unlock-table');
    if (statusEl) statusEl.textContent = '正在同步限售解禁日历…';
    if (!state.unlock.payload || force) {
      if (tableEl) tableEl.innerHTML = '<div class="module-loading">正在同步限售解禁日历</div>';
    }
    try {
      const qs = new URLSearchParams({ days:String(state.unlock.days) });
      if (force) qs.set('refresh', '1');
      const response = await fetch(`/api/smart-money/unlock?${qs}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '限售解禁数据加载失败');
      if (requestId !== state.unlock.requestId) return;
      state.unlock.payload = payload;
      state.unlock.loaded = true;
      renderUnlock();
    } catch (error) {
      if (requestId !== state.unlock.requestId) return;
      if (statusEl) statusEl.textContent = error.message || '解禁数据暂时不可用';
      if (tableEl) tableEl.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}<br><button class="refresh-btn" type="button" onclick="SmartMoney.refreshActive()">重新获取</button></div>`;
    } finally {
      if (requestId === state.unlock.requestId) state.unlock.loading = false;
    }
  }

  function setTab(tab) {
    if (!['lhb', 'margin', 'unlock'].includes(tab)) return;
    state.tab = tab;
    document.querySelectorAll('[data-sm-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.smTab === tab));
    document.querySelectorAll('[data-sm-panel]').forEach(panel => { panel.hidden = panel.dataset.smPanel !== tab; });
    if (tab === 'lhb' && !state.lhb.loaded) loadLhb();
    if (tab === 'margin' && !state.margin.loaded) loadMargin();
    if (tab === 'unlock' && !state.unlock.loaded) loadUnlock();
  }

  function load() {
    setTab(state.tab);
  }

  function refreshActive() {
    if (state.tab === 'lhb') loadLhb(true);
    else if (state.tab === 'margin') loadMargin(true);
    else loadUnlock(true);
  }

  function setLhbDate(date) {
    state.lhb.date = String(date || '').trim();
    state.lhb.selectedKey = '';
    loadLhb(true);
  }

  function setLhbFilter(filter) {
    if (!['all', 'institution', 'tracked'].includes(filter)) return;
    state.lhb.filter = filter;
    document.querySelectorAll('[data-sm-lhb-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.smLhbFilter === filter));
    renderLhb();
  }

  function setLhbQuery(query) {
    state.lhb.query = String(query || '');
    renderLhb();
  }

  function setMarginSort(sort) {
    if (!['netBuy', 'balance', 'buy', 'shortBalance'].includes(sort)) return;
    state.margin.sort = sort;
    document.querySelectorAll('[data-sm-margin-sort]').forEach(btn => btn.classList.toggle('active', btn.dataset.smMarginSort === sort));
    loadMargin(true);
  }

  function setMarginOnlyTracked(checked) {
    state.margin.onlyTracked = Boolean(checked);
    renderMargin();
  }

  function setMarginQuery(query) {
    state.margin.query = String(query || '');
    renderMargin();
  }

  function setUnlockDays(days) {
    const n = Number(days);
    if (![7, 30, 60, 90].includes(n)) return;
    state.unlock.days = n;
    document.querySelectorAll('[data-sm-unlock-days]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.smUnlockDays) === n));
    loadUnlock(true);
  }

  function setUnlockFilter(filter) {
    if (!['all', 'tracked', 'high'].includes(filter)) return;
    state.unlock.filter = filter;
    document.querySelectorAll('[data-sm-unlock-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.smUnlockFilter === filter));
    renderUnlock();
  }

  function setUnlockQuery(query) {
    state.unlock.query = String(query || '');
    renderUnlock();
  }

  window.SmartMoney = {
    load,
    refreshActive,
    setTab,
    setLhbDate,
    setLhbFilter,
    setLhbQuery,
    inspectSeats,
    setMarginSort,
    setMarginOnlyTracked,
    setMarginQuery,
    setUnlockDays,
    setUnlockFilter,
    setUnlockQuery,
    openStock,
    addUnlockToWorkbench,
  };
})();
