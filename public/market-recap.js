/* Daily Market Recap page: aggregates indexes, breadth, limit pools, board ladder, sectors and note/AI handoff. */
(function () {
  'use strict';

  const state = {
    payload:null,
    loading:false,
    loaded:false,
    requestId:0,
    poolTab:'yesterday',
    poolQuery:'',
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

  function fmtDate(value) {
    const raw = String(value || '').trim();
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return raw || '--';
  }

  function fmtTime(value) {
    const n = num(value);
    if (!n || n <= 0) return '--';
    const text = String(Math.trunc(n)).padStart(6, '0');
    return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`;
  }

  function fmtPct(value) {
    const n = num(value);
    if (n == null) return '--';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  function fmtPrice(value) {
    const n = num(value);
    return n == null ? '--' : n.toFixed(2);
  }

  function fmtSignedMoney(value) {
    const n = num(value);
    if (n == null) return '--';
    const abs = Math.abs(n);
    const prefix = n > 0 ? '+' : n < 0 ? '-' : '';
    if (abs >= 1e8) return `${prefix}${(abs / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${prefix}${(abs / 1e4).toFixed(2)}万`;
    return `${prefix}${Math.round(abs).toLocaleString('zh-CN')}`;
  }

  function fmtPlainAmount(value) {
    const n = num(value);
    if (n == null || n <= 0) return '--';
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
    return Math.round(n).toLocaleString('zh-CN');
  }

  function tone(value) {
    const n = num(value);
    if (n == null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  }

  function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
  }

  function openStock(symbol, name, price, pct, amount) {
    if (!symbol) return;
    if (typeof window.openMarketStockPreview === 'function') {
      window.openMarketStockPreview({ symbol, name, price, pct, amount });
    } else if (typeof window.openModal === 'function') {
      window.openModal(symbol);
    }
  }

  function openIndex(code) {
    if (!code) return;
    if (typeof window.openMarketIndex === 'function') window.openMarketIndex(code);
  }

  function openBoard(name, kind) {
    if (!name) return;
    if (typeof window.openStockBoard === 'function') {
      window.openStockBoard({ kind:kind || '行业', name });
    }
  }

  function buildMarkdown(recap) {
    const displayDate = fmtDate(recap?.date || new Date().toISOString().slice(0, 10));
    const lines = [`# A 股每日市场复盘（${displayDate}）`, ''];
    const sentiment = recap?.sentiment || {};
    const breadth = recap?.breadth || {};
    const trading = recap?.trading || {};
    const turnover = recap?.turnoverComparison || null;
    const turnoverNote = turnover && num(turnover.diffRatio) != null
      ? `（较前一日${turnover.diffRatio >= 0 ? '放量' : '缩量'} ${Math.abs(turnover.diffRatio).toFixed(2)}%）`
      : '';

    lines.push('## 一、市场全景与情绪');
    lines.push(`- **情绪温度**：${sentiment.label || '--'}${sentiment.score != null ? `（${sentiment.score} 分）` : ''}`);
    lines.push(`- **两市成交额**：${fmtPlainAmount(trading.amount)}${turnoverNote}`);
    lines.push(`- **涨跌分布**：上涨 ${breadth.rising ?? '--'} 家 / 平盘 ${breadth.flat ?? '--'} 家 / 下跌 ${breadth.falling ?? '--'} 家${sentiment.riseRatio != null ? `（上涨占比 ${sentiment.riseRatio}%）` : ''}`);
    lines.push(`- **涨跌停生态**：涨停 ${recap?.limits?.upTotal ?? '--'} 家、跌停 ${recap?.limits?.downTotal ?? '--'} 家、炸板 ${recap?.limits?.brokenTotal ?? '--'} 家${sentiment.sealRate != null ? `（封板率 ${sentiment.sealRate}%）` : ''}`);
    if (recap?.yesterdayLimit?.total) {
      lines.push(`- **昨日涨停今日表现**：共 ${recap.yesterdayLimit.total} 家，平均涨跌 ${fmtPct(recap.yesterdayLimit.avgPct)}，红盘率 ${recap.yesterdayLimit.winRate != null ? `${recap.yesterdayLimit.winRate}%` : '--'}`);
    }
    if (recap?.mainFlow && num(recap.mainFlow.mainNet) != null) {
      lines.push(`- **沪深主力资金**：${fmtSignedMoney(recap.mainFlow.mainNet)}（超大单 ${fmtSignedMoney(recap.mainFlow.superLargeNet)}，大单 ${fmtSignedMoney(recap.mainFlow.largeNet)}）`);
    }
    lines.push('');

    const indexes = Array.isArray(recap?.indexes) ? recap.indexes : [];
    if (indexes.length) {
      lines.push('## 二、主要指数表现');
      lines.push('| 指数 | 最新点位 | 涨跌幅 |');
      lines.push('| --- | ---: | ---: |');
      indexes.forEach(item => {
        lines.push(`| ${item.name || item.code} | ${fmtPrice(item.price)} | ${fmtPct(item.pct)} |`);
      });
      lines.push('');
    }

    const ladder = recap?.ladder || {};
    if (Array.isArray(ladder.levels) && ladder.levels.length) {
      lines.push('## 三、连板梯队与题材主线');
      lines.push(`- **最高连板**：${ladder.maxBoard ? `${ladder.maxBoard} 连板` : '--'}`);
      if (Array.isArray(ladder.hotThemes) && ladder.hotThemes.length) {
        lines.push(`- **涨停集中行业**：${ladder.hotThemes.slice(0, 6).map(t => `${t.industry}(${t.count})`).join('、')}`);
      }
      ladder.levels.filter(l => l.boards >= 2).slice(0, 5).forEach(level => {
        const names = level.stocks.slice(0, 8).map(s => `${s.name}${s.industry ? `(${s.industry})` : ''}`).join('、');
        lines.push(`- **${level.label}（${level.count} 家）**：${names}${level.stocks.length > 8 ? ' 等' : ''}`);
      });
      lines.push('');
    }

    const sectors = recap?.sectors || {};
    if (sectors.rising?.length || sectors.falling?.length) {
      lines.push('## 四、行业与概念强弱');
      if (sectors.rising?.length) lines.push(`- **领涨行业**：${sectors.rising.slice(0, 5).map(b => `${b.name}(${fmtPct(b.pct)})`).join('、')}`);
      if (sectors.falling?.length) lines.push(`- **领跌行业**：${sectors.falling.slice(0, 5).map(b => `${b.name}(${fmtPct(b.pct)})`).join('、')}`);
      if (sectors.inflow?.length) lines.push(`- **主力净流入行业**：${sectors.inflow.slice(0, 5).map(b => `${b.name}(${fmtSignedMoney(b.mainNetInflow)})`).join('、')}`);
      if (sectors.hotConcepts?.length) lines.push(`- **领涨概念**：${sectors.hotConcepts.slice(0, 5).map(b => `${b.name}(${fmtPct(b.pct)})`).join('、')}`);
      lines.push('');
    }

    lines.push('## 五、个人复盘与明日计划');
    lines.push('- 今日核心主线与情绪判断：');
    lines.push('- 自选与持仓复盘结论：');
    lines.push('- 明日观察标的与风控点位：');
    lines.push('');
    lines.push('> 数据整理自公开行情接口，仅供研究复盘，不构成投资建议。');
    return lines.join('\n');
  }

  function renderSummary(data) {
    const sentiment = data?.sentiment || {};
    const breadth = data?.breadth || {};
    const trading = data?.trading || {};
    const limits = data?.limits || {};
    const yest = data?.yesterdayLimit || null;
    const flow = data?.mainFlow || null;
    const turnover = data?.turnoverComparison || null;

    const score = sentiment.score;
    const scoreTone = sentiment.tone || 'flat';
    const turnoverNote = turnover && num(turnover.diffRatio) != null
      ? `较前日 ${turnover.diffRatio >= 0 ? '放量 +' : '缩量 '}${turnover.diffRatio.toFixed(2)}%`
      : '沪深两市实时成交额';

    const cards = [
      {
        label:'情绪温度',
        value:sentiment.label || '--',
        tone:scoreTone,
        note:score != null ? `综合得分 ${score} / 100` : '等待交易数据',
        meter:score,
      },
      {
        label:'两市成交额',
        value:fmtPlainAmount(trading.amount),
        tone:turnover && num(turnover.diffRatio) != null ? tone(turnover.diffRatio) : '',
        note:turnoverNote,
      },
      {
        label:'封板率',
        value:sentiment.sealRate != null ? `${sentiment.sealRate}%` : '--',
        tone:sentiment.sealRate != null ? (sentiment.sealRate >= 70 ? 'up' : sentiment.sealRate < 50 ? 'down' : 'flat') : '',
        note:`涨停 ${limits.upTotal ?? '--'} · 炸板 ${limits.brokenTotal ?? '--'} · 跌停 ${limits.downTotal ?? '--'}`,
      },
      {
        label:'昨日涨停溢价',
        value:yest && yest.avgPct != null ? fmtPct(yest.avgPct) : '--',
        tone:yest ? tone(yest.avgPct) : '',
        note:yest?.total ? `${yest.total} 家 · 红盘率 ${yest.winRate != null ? `${yest.winRate}%` : '--'}` : '暂无昨日涨停数据',
      },
      {
        label:'沪深主力资金',
        value:flow && num(flow.mainNet) != null ? fmtSignedMoney(flow.mainNet) : '--',
        tone:flow ? tone(flow.mainNet) : '',
        note:flow && num(flow.superLargeNet) != null ? `超大单 ${fmtSignedMoney(flow.superLargeNet)}` : '东方财富分钟合计',
      },
    ];

    const grid = document.getElementById('recap-summary-grid');
    if (grid) {
      grid.innerHTML = cards.map(card => `
        <div class="metric-card recap-metric-card">
          <div class="metric-label">${esc(card.label)}</div>
          <div class="metric-value ${card.tone ? esc(card.tone) : ''}">${esc(card.value)}</div>
          ${card.meter != null ? `<div class="recap-meter" aria-hidden="true"><span style="width:${Math.max(4, Math.min(100, card.meter))}%"></span></div>` : ''}
          <div class="metric-note">${esc(card.note)}</div>
        </div>
      `).join('');
    }

    const rising = num(breadth.rising) || 0;
    const flat = num(breadth.flat) || 0;
    const falling = num(breadth.falling) || 0;
    const total = rising + flat + falling;
    const breadthEl = document.getElementById('recap-breadth-bar');
    if (breadthEl) {
      if (!total) {
        breadthEl.innerHTML = '<div class="recap-empty-inline">暂无全市场涨跌分布数据</div>';
      } else {
        const upPct = (rising / total * 100).toFixed(1);
        const flatPct = (flat / total * 100).toFixed(1);
        const downPct = (falling / total * 100).toFixed(1);
        breadthEl.innerHTML = `
          <div class="recap-breadth-head">
            <span class="up">上涨 <strong>${rising}</strong> 家（${upPct}%）</span>
            <span class="flat">平盘 <strong>${flat}</strong> 家</span>
            <span class="down">下跌 <strong>${falling}</strong> 家（${downPct}%）</span>
          </div>
          <div class="recap-breadth-track" role="img" aria-label="上涨 ${rising} 家，平盘 ${flat} 家，下跌 ${falling} 家">
            <span class="recap-seg-up" style="width:${upPct}%"></span>
            <span class="recap-seg-flat" style="width:${flatPct}%"></span>
            <span class="recap-seg-down" style="width:${downPct}%"></span>
          </div>
        `;
      }
    }
  }

  function renderIndexes(data) {
    const container = document.getElementById('recap-indexes');
    if (!container) return;
    const rows = Array.isArray(data?.indexes) ? data.indexes : [];
    if (!rows.length) {
      container.innerHTML = '<div class="recap-empty-inline">主要指数暂不可用</div>';
      return;
    }
    container.innerHTML = rows.map(item => `
      <button class="recap-index-card ${tone(item.pct)}" type="button" onclick="MarketRecap.openIndex('${esc(item.code)}')">
        <span class="recap-index-name">${esc(item.name || item.code)}</span>
        <strong class="recap-index-price">${esc(fmtPrice(item.price))}</strong>
        <span class="recap-index-pct ${tone(item.pct)}">${esc(fmtPct(item.pct))}</span>
      </button>
    `).join('');
  }

  function renderLadder(data) {
    const container = document.getElementById('recap-ladder');
    const themesEl = document.getElementById('recap-hot-themes');
    const noteEl = document.getElementById('recap-ladder-status');
    const ladder = data?.ladder || {};
    const levels = Array.isArray(ladder.levels) ? ladder.levels : [];
    const hotThemes = Array.isArray(ladder.hotThemes) ? ladder.hotThemes : [];

    if (noteEl) {
      noteEl.textContent = ladder.total
        ? `共 ${ladder.total} 只涨停 · 最高 ${ladder.maxBoard || 1} 板`
        : '当前交易日暂无涨停梯队数据';
    }
    if (themesEl) {
      themesEl.innerHTML = hotThemes.length
        ? hotThemes.map(item => `<button class="recap-theme-chip" type="button" onclick="MarketRecap.openBoard('${esc(item.industry)}','行业')"><span>${esc(item.industry)}</span><b>${item.count}</b></button>`).join('')
        : '<span class="recap-empty-inline">暂无涨停行业聚焦</span>';
    }
    if (!container) return;
    if (!levels.length) {
      container.innerHTML = '<div class="recap-empty-inline">非交易日或盘前可能暂无连板数据</div>';
      return;
    }
    container.innerHTML = levels.map(level => {
      const limit = level.boards === 1 ? 24 : 30;
      const visible = level.stocks.slice(0, limit);
      const hiddenCount = Math.max(0, level.stocks.length - visible.length);
      return `
        <div class="recap-ladder-row">
          <div class="recap-ladder-badge ${level.boards >= 3 ? 'hot' : ''}">
            <strong>${esc(level.label)}</strong>
            <small>${level.count} 家</small>
          </div>
          <div class="recap-ladder-stocks">
            ${visible.map(stock => stock.symbol
              ? `<button class="recap-stock-pill" type="button" onclick="MarketRecap.openStock('${esc(stock.symbol)}','${esc(stock.name)}',null,${num(stock.pct) ?? 'null'},null)" title="${esc(stock.industry || '')} 首次封板 ${fmtTime(stock.firstSealTime)}"><span>${esc(stock.name)}</span>${stock.industry ? `<small>${esc(stock.industry)}</small>` : ''}</button>`
              : `<span class="recap-stock-pill"><span>${esc(stock.name)}</span>${stock.industry ? `<small>${esc(stock.industry)}</small>` : ''}</span>`
            ).join('')}
            ${hiddenCount ? `<button class="recap-stock-pill more" type="button" onclick="switchAppPage('limit-pools')">还有 ${hiddenCount} 只 →</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderSectors(data) {
    const container = document.getElementById('recap-sectors-grid');
    if (!container) return;
    const sectors = data?.sectors || {};
    const groups = [
      { title:'领涨行业', kind:'行业', rows:sectors.rising || [], metric:'pct' },
      { title:'领跌行业', kind:'行业', rows:sectors.falling || [], metric:'pct' },
      { title:'主力流入行业', kind:'行业', rows:sectors.inflow || [], metric:'flow' },
      { title:'领涨概念', kind:'概念', rows:sectors.hotConcepts || [], metric:'pct' },
    ];
    container.innerHTML = groups.map(group => `
      <div class="recap-sector-box">
        <div class="recap-sector-head"><strong>${esc(group.title)}</strong><span>${group.rows.length ? '前 ' + group.rows.length : '--'}</span></div>
        ${group.rows.length ? `<div class="recap-sector-list">${group.rows.map(item => {
          const val = group.metric === 'flow' ? fmtSignedMoney(item.mainNetInflow) : fmtPct(item.pct);
          const clsName = group.metric === 'flow' ? tone(item.mainNetInflow) : tone(item.pct);
          return `<button class="recap-sector-item" type="button" onclick="MarketRecap.openBoard('${esc(item.name)}','${esc(group.kind)}')"><span>${esc(item.name)}</span><strong class="${clsName}">${esc(val)}</strong></button>`;
        }).join('')}</div>` : '<div class="recap-empty-inline">暂不可用</div>'}
      </div>
    `).join('');
  }

  function renderPoolTable() {
    const container = document.getElementById('recap-pool-content');
    if (!container) return;
    const data = state.payload;
    if (!data) {
      container.innerHTML = '<div class="recap-empty-inline">正在等待复盘数据…</div>';
      return;
    }
    const q = state.poolQuery.trim().toLowerCase();
    const filterRows = (rows) => !q ? rows : rows.filter(r =>
      `${r.code} ${r.name} ${r.industry || ''}`.toLowerCase().includes(q)
    );

    if (state.poolTab === 'yesterday') {
      const rows = filterRows(Array.isArray(data.yesterdayLimit?.data) ? data.yesterdayLimit.data : []);
      if (!rows.length) { container.innerHTML = '<div class="recap-empty-inline">暂无匹配的昨日涨停股数据</div>'; return; }
      container.innerHTML = `<table class="limit-pool-table"><thead><tr><th>序号</th><th>股票</th><th>最新价</th><th>今日涨跌</th><th>昨日连板</th><th>换手率</th><th>成交额</th><th>所属行业</th></tr></thead><tbody>${rows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="MarketRecap.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.price) ?? 'null'},${num(r.pct) ?? 'null'},${num(r.amount) ?? 'null'})">${esc(r.name)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)}<small>${esc(r.code)}</small></span>`}</td>
          <td>${esc(fmtPrice(r.price))}</td>
          <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
          <td>${r.yesterdayContinuous ? `${r.yesterdayContinuous} 板` : '--'}</td>
          <td>${num(r.turnover) != null ? `${r.turnover.toFixed(2)}%` : '--'}</td>
          <td>${esc(fmtPlainAmount(r.amount))}</td>
          <td>${esc(r.industry || '--')}</td>
        </tr>`).join('')}</tbody></table>`;
      return;
    }

    if (state.poolTab === 'broken') {
      const rows = filterRows(Array.isArray(data.limits?.brokenPreview) ? data.limits.brokenPreview : []);
      if (!rows.length) { container.innerHTML = '<div class="recap-empty-inline">暂无匹配的炸板股数据</div>'; return; }
      container.innerHTML = `<table class="limit-pool-table"><thead><tr><th>序号</th><th>股票</th><th>最新价</th><th>涨跌幅</th><th>首次封板</th><th>炸板次数</th><th>换手率</th><th>成交额</th><th>所属行业</th></tr></thead><tbody>${rows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="MarketRecap.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.price) ?? 'null'},${num(r.pct) ?? 'null'},${num(r.amount) ?? 'null'})">${esc(r.name)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)}<small>${esc(r.code)}</small></span>`}</td>
          <td>${esc(fmtPrice(r.price))}</td>
          <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
          <td>${esc(fmtTime(r.firstSealTime))}</td>
          <td>${num(r.brokenCount) ?? 1}</td>
          <td>${num(r.turnover) != null ? `${r.turnover.toFixed(2)}%` : '--'}</td>
          <td>${esc(fmtPlainAmount(r.amount))}</td>
          <td>${esc(r.industry || '--')}</td>
        </tr>`).join('')}</tbody></table>`;
      return;
    }

    const rows = filterRows(Array.isArray(data.limits?.downPreview) ? data.limits.downPreview : []);
    if (!rows.length) { container.innerHTML = '<div class="recap-empty-inline">当前暂无跌停股数据</div>'; return; }
    container.innerHTML = `<table class="limit-pool-table"><thead><tr><th>序号</th><th>股票</th><th>最新价</th><th>涨跌幅</th><th>连续跌停</th><th>最后封板</th><th>成交额</th><th>所属行业</th></tr></thead><tbody>${rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${r.symbol ? `<button class="limit-pool-stock" type="button" onclick="MarketRecap.openStock('${esc(r.symbol)}','${esc(r.name)}',${num(r.price) ?? 'null'},${num(r.pct) ?? 'null'},${num(r.amount) ?? 'null'})">${esc(r.name)}<small>${esc(r.code)}</small></button>` : `<span>${esc(r.name)}<small>${esc(r.code)}</small></span>`}</td>
        <td>${esc(fmtPrice(r.price))}</td>
        <td class="${tone(r.pct)}">${esc(fmtPct(r.pct))}</td>
        <td>${num(r.continuousCount) || 1}</td>
        <td>${esc(fmtTime(r.lastSealTime))}</td>
        <td>${esc(fmtPlainAmount(r.amount))}</td>
        <td>${esc(r.industry || '--')}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function render() {
    const data = state.payload;
    if (!data) return;
    const statusEl = document.getElementById('recap-status');
    if (statusEl) {
      const updated = num(data.fetchedAt)
        ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
        : '刚刚';
      const partialNote = data.partial && Array.isArray(data.unavailable) && data.unavailable.length
        ? ` · 部分暂不可用：${data.unavailable.join('、')}`
        : '';
      statusEl.textContent = `交易日 ${fmtDate(data.date)} · ${data.stale ? '缓存数据' : `${updated} 更新`}${partialNote}`;
    }
    renderSummary(data);
    renderIndexes(data);
    renderLadder(data);
    renderSectors(data);
    renderPoolTable();
  }

  async function load(force = false, { background = false } = {}) {
    if (state.loading && !force) return;
    if (!force && state.loaded && !background) { render(); return; }
    const requestId = ++state.requestId;
    state.loading = true;
    const statusEl = document.getElementById('recap-status');
    if (!background && statusEl) statusEl.textContent = force ? '正在重新同步每日复盘…' : '正在同步每日复盘…';
    try {
      const response = await fetch(`/api/market-recap${force ? '?refresh=1' : ''}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '每日复盘加载失败');
      if (requestId !== state.requestId) return;
      state.payload = payload;
      state.loaded = true;
      render();
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (!background) {
        if (statusEl) statusEl.textContent = error.message || '每日复盘暂时不可用';
        if (!state.payload) {
          const grid = document.getElementById('recap-summary-grid');
          if (grid) grid.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}</div>`;
        }
      }
    } finally {
      if (requestId === state.requestId) state.loading = false;
    }
  }

  function setPoolTab(tab) {
    if (!['yesterday', 'broken', 'down'].includes(tab)) return;
    state.poolTab = tab;
    document.querySelectorAll('[data-recap-pool-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.recapPoolTab === tab);
    });
    renderPoolTable();
  }

  function setPoolQuery(value) {
    state.poolQuery = String(value || '');
    renderPoolTable();
  }

  async function copyMarkdown() {
    if (!state.payload) { toast('请先等待复盘数据加载完成', true); return; }
    const text = buildMarkdown(state.payload);
    try {
      await navigator.clipboard.writeText(text);
      toast('今日复盘 Markdown 已复制到剪贴板');
    } catch (_) {
      toast('剪贴板写入受限，请登录并直接生成个人笔记', true);
    }
  }

  async function saveToNote() {
    if (!state.payload) { toast('请先等待复盘数据加载完成', true); return; }
    const loggedIn = typeof window.isLoggedInUser === 'function' ? window.isLoggedInUser() : Boolean(window.currentUser);
    if (!loggedIn) {
      toast('登录后可将复盘一键保存到个人笔记', true);
      if (typeof window.openAuthModal === 'function') window.openAuthModal('login');
      return;
    }
    const displayDate = fmtDate(state.payload.date || new Date().toISOString().slice(0, 10));
    const title = `每日复盘 ${displayDate}`;
    const content = buildMarkdown(state.payload);
    try {
      const resp = await window.apiRequest('/api/notes', {
        method:'POST',
        body:JSON.stringify({ title, content }),
      });
      toast('已生成今日复盘笔记');
      if (typeof window.switchAppPage === 'function') window.switchAppPage('notes');
      if (typeof window.loadNotesList === 'function') await window.loadNotesList({ reloadFolders:true });
      if (resp?.note?.id && typeof window.openNote === 'function') await window.openNote(resp.note.id);
    } catch (error) {
      toast(`生成复盘笔记失败：${error.message || '请稍后重试'}`, true);
    }
  }

  function sendToAi() {
    if (!state.payload) { toast('请先等待复盘数据加载完成', true); return; }
    if (typeof window.hasAiMenuAccess !== 'function' || !window.hasAiMenuAccess()) {
      toast('当前账号未开启 AI 问股权限', true);
      return;
    }
    const markdown = buildMarkdown(state.payload);
    if (typeof window.switchAppPage === 'function') window.switchAppPage('ai');
    window.setTimeout(() => {
      const input = document.getElementById('ai-message-input');
      if (input) {
        input.value = `请基于以下今日 A 股市场复盘数据，帮我总结市场主线、情绪周期定位、核心风险和明日观察重点：\n\n${markdown}`;
        input.focus();
      }
    }, 60);
  }

  window.MarketRecap = {
    load,
    setPoolTab,
    setPoolQuery,
    openStock,
    openIndex,
    openBoard,
    copyMarkdown,
    saveToNote,
    sendToAi,
    buildMarkdown,
  };
})();
