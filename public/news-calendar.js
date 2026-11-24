/* 7x24 Financial News Flash & Macro / Earnings / Ex-Dividend Calendar */
(function () {
  'use strict';

  const state = {
    view: 'flash', // 'flash' | 'calendar'
    flash: {
      channel: 'all',
      onlyImportant: false,
      onlyTracked: false,
      query: '',
      loading: false,
      loaded: false,
      requestId: 0,
      payload: null,
    },
    calendar: {
      days: 30,
      filter: 'all', // 'all' | 'macro' | 'earnings' | 'dividend' | 'tracked'
      query: '',
      loading: false,
      loaded: false,
      requestId: 0,
      payload: null,
    },
  };

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function safeExternalUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'https:' || !/(^|\.)eastmoney\.com$/i.test(parsed.hostname)) return '';
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
  }

  function trackedSets() {
    if (typeof window.getTrackedStockInfo === 'function') return window.getTrackedStockInfo();
    return { watchlistCodes: new Set(), positionCodes: new Set() };
  }

  function isCodeTracked(code) {
    if (!code) return false;
    const { watchlistCodes, positionCodes } = trackedSets();
    return positionCodes.has(code) || watchlistCodes.has(code);
  }

  function trackedBadges(code) {
    if (!code) return '';
    const { watchlistCodes, positionCodes } = trackedSets();
    const out = [];
    if (positionCodes.has(code)) out.push('<span class="sm-tag sm-tag-pos">持仓</span>');
    if (watchlistCodes.has(code)) out.push('<span class="sm-tag sm-tag-watch">自选</span>');
    return out.join('');
  }

  function openStock(symbol, name) {
    if (!symbol) return;
    if (typeof window.openMarketStockPreview === 'function') {
      window.openMarketStockPreview({ symbol, name });
    } else if (typeof window.openModal === 'function') {
      window.openModal(symbol);
    }
  }

  function askAiAboutNews(title, summary) {
    if (typeof window.hasAiMenuAccess !== 'function' || !window.hasAiMenuAccess()) {
      toast('当前账号未开启 AI 问股权限', true);
      return;
    }
    const text = [title, summary && summary !== title ? summary : ''].filter(Boolean).join('\n');
    if (typeof window.switchAppPage === 'function') window.switchAppPage('ai');
    window.setTimeout(() => {
      const input = document.getElementById('ai-message-input');
      if (input) {
        input.value = `请解读以下财经快讯对 A 股市场及相关板块/个股的潜在影响与风险点：\n\n${text}`;
        input.focus();
      }
    }, 60);
  }

  function addEventToWorkbench(date, title, kind) {
    if (typeof window.addWorkbenchEventQuick === 'function' && window.addWorkbenchEventQuick({ date, title, kind })) {
      toast(`已加入投资工作台日历：${title}`);
      return;
    }
    toast('添加日历事件失败，请稍后重试', true);
  }

  function renderFlash() {
    const data = state.flash.payload;
    const listEl = document.getElementById('nc-flash-list');
    const statusEl = document.getElementById('nc-flash-status');
    const summaryEl = document.getElementById('nc-flash-summary');
    if (!data || !listEl) return;

    const allItems = Array.isArray(data.items) ? data.items : [];
    const importantCount = allItems.filter(item => item.important).length;
    const trackedCount = allItems.filter(item =>
      (item.stocks || []).some(s => isCodeTracked(s.code))
    ).length;

    if (statusEl) {
      const updated = data.fetchedAt
        ? new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
        : '刚刚';
      statusEl.textContent = `${data.label || '快讯'} · ${data.stale ? '缓存数据' : `${updated} 同步`}`;
    }

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">本批实时电报</div><div class="metric-value">${allItems.length}</div><div class="metric-note">每 30 秒自动静默同步</div></div>
        <div class="metric-card"><div class="metric-label">重要/焦点标红</div><div class="metric-value up">${importantCount}</div><div class="metric-note">宏观政策与关键异动</div></div>
        <div class="metric-card"><div class="metric-label">关联自选/持仓</div><div class="metric-value ${trackedCount ? 'up' : ''}">${trackedCount}</div><div class="metric-note">按股票代码自动识别</div></div>
      `;
    }

    const q = state.flash.query.trim().toLowerCase();
    let visible = allItems;
    if (state.flash.onlyImportant) visible = visible.filter(item => item.important);
    if (state.flash.onlyTracked) {
      visible = visible.filter(item => (item.stocks || []).some(s => isCodeTracked(s.code)));
    }
    if (q) {
      visible = visible.filter(item => `${item.title} ${item.summary} ${(item.stocks || []).map(s => s.code).join(' ')}`.toLowerCase().includes(q));
    }

    if (!visible.length) {
      listEl.innerHTML = '<div class="recap-empty-inline">当前筛选条件下暂无匹配的实时快讯</div>';
      return;
    }

    listEl.innerHTML = visible.map((item, idx) => {
      const href = safeExternalUrl(item.url);
      const timeDisplay = String(item.time || '').slice(-8) || '--:--';
      const dateDisplay = String(item.time || '').slice(0, 10);
      const showSummary = item.summary && item.summary !== item.title;
      const stocksHtml = (item.stocks || []).map(s => s.symbol
        ? `<button class="nc-stock-chip" type="button" onclick="NewsCalendar.openStock('${esc(s.symbol)}','${esc(s.code)}')">${esc(s.code)}${trackedBadges(s.code)}</button>`
        : `<span class="nc-stock-chip">${esc(s.code)}</span>`
      ).join('');
      return `
        <article class="nc-flash-item${item.important ? ' important' : ''}">
          <div class="nc-flash-time">
            <span class="nc-flash-dot"></span>
            <strong>${esc(timeDisplay)}</strong>
            ${/^\d{4}-\d{2}-\d{2}$/.test(dateDisplay) ? `<small>${esc(dateDisplay.slice(5))}</small>` : ''}
          </div>
          <div class="nc-flash-body">
            <div class="nc-flash-head">
              ${item.important ? '<span class="sm-tag sm-tag-warn">重要</span>' : ''}
              <h3 class="nc-flash-title">${esc(item.title)}</h3>
            </div>
            ${showSummary ? `<p class="nc-flash-summary-text">${esc(item.summary)}</p>` : ''}
            <div class="nc-flash-foot">
              <div class="nc-flash-stocks">${stocksHtml}</div>
              <div class="nc-flash-actions">
                <button class="sm-action-btn" type="button" onclick="NewsCalendar.askAiByIndex(${idx})">✦ AI 解读</button>
                ${href ? `<a class="sm-action-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>` : ''}
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
    listEl._visibleItems = visible;
  }

  function askAiByIndex(idx) {
    const listEl = document.getElementById('nc-flash-list');
    const item = listEl?._visibleItems?.[idx];
    if (item) askAiAboutNews(item.title, item.summary);
  }

  async function loadFlash(force = false, { background = false } = {}) {
    if (state.flash.loading && !force) return;
    const requestId = ++state.flash.requestId;
    state.flash.loading = true;
    const statusEl = document.getElementById('nc-flash-status');
    const listEl = document.getElementById('nc-flash-list');
    if (!background && statusEl) statusEl.textContent = '正在同步 7×24 实时快讯…';
    if (!background && (!state.flash.payload || force) && listEl) {
      listEl.innerHTML = '<div class="module-loading">正在同步 7×24 实时财经电报</div>';
    }
    try {
      const qs = new URLSearchParams({ channel: state.flash.channel });
      if (force) qs.set('refresh', '1');
      const response = await fetch(`/api/news-flash?${qs}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '实时快讯加载失败');
      if (requestId !== state.flash.requestId) return;
      state.flash.payload = payload;
      state.flash.loaded = true;
      renderFlash();
    } catch (error) {
      if (requestId !== state.flash.requestId) return;
      if (!background) {
        if (statusEl) statusEl.textContent = error.message || '实时快讯暂时不可用';
        if (!state.flash.payload && listEl) {
          listEl.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}<br><button class="refresh-btn" type="button" onclick="NewsCalendar.refreshActive()">重新加载</button></div>`;
        }
      }
    } finally {
      if (requestId === state.flash.requestId) state.flash.loading = false;
    }
  }

  function renderCalendar() {
    const data = state.calendar.payload;
    const summaryEl = document.getElementById('nc-cal-summary');
    const alertEl = document.getElementById('nc-cal-alert');
    const listEl = document.getElementById('nc-cal-list');
    const statusEl = document.getElementById('nc-cal-status');
    if (!data || !listEl) return;

    const macro = (Array.isArray(data.macro) ? data.macro : []).map(e => ({ ...e, kindLabel: '宏观' }));
    const earnings = (Array.isArray(data.earnings) ? data.earnings : []).map(e => ({ ...e, kindLabel: '财报' }));
    const dividends = (Array.isArray(data.dividends) ? data.dividends : []).map(e => ({ ...e, kindLabel: '分红' }));
    const combined = [...macro, ...earnings, ...dividends].sort((a, b) => a.date.localeCompare(b.date));
    const trackedEvents = combined.filter(e => e.code && isCodeTracked(e.code));

    if (statusEl) {
      const partialNote = data.partial && data.unavailable?.length ? ` · 部分降级：${data.unavailable.join('、')}` : '';
      statusEl.textContent = `${data.startDate} 至 ${data.endDate}${partialNote}`;
    }

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">宏观重要窗口</div><div class="metric-value">${macro.length}</div><div class="metric-note">央行/通胀/非农/期指交割</div></div>
        <div class="metric-card"><div class="metric-label">财报预约披露</div><div class="metric-value">${earnings.length}</div><div class="metric-note">沪深定期报告预约日</div></div>
        <div class="metric-card"><div class="metric-label">分红除权除息</div><div class="metric-value">${dividends.length}</div><div class="metric-note">股权登记与除权派息</div></div>
        <div class="metric-card"><div class="metric-label">自选/持仓事件</div><div class="metric-value ${trackedEvents.length ? 'up' : ''}">${trackedEvents.length}</div><div class="metric-note">${trackedEvents.length ? '点击下方可一键加入工作台' : '区间内暂无命中'}</div></div>
      `;
    }

    if (alertEl) {
      if (trackedEvents.length) {
        alertEl.hidden = false;
        alertEl.innerHTML = `<strong>自选/持仓日程提醒：</strong>未来 ${data.days} 天内共有 <b>${trackedEvents.length}</b> 项与您的自选或模拟持仓相关：${trackedEvents.slice(0, 5).map(e => `${esc(e.name)}(${esc(e.date)} ${esc(e.kindLabel)})`).join('、')}${trackedEvents.length > 5 ? ' 等' : ''}。`;
      } else {
        alertEl.hidden = true;
        alertEl.innerHTML = '';
      }
    }

    const q = state.calendar.query.trim().toLowerCase();
    let filtered = combined;
    if (state.calendar.filter === 'macro') filtered = macro;
    else if (state.calendar.filter === 'earnings') filtered = earnings;
    else if (state.calendar.filter === 'dividend') filtered = dividends;
    else if (state.calendar.filter === 'tracked') filtered = trackedEvents;

    if (q) {
      filtered = filtered.filter(e => `${e.date} ${e.title} ${e.code || ''} ${e.name || ''} ${e.region || ''} ${e.note || ''}`.toLowerCase().includes(q));
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div class="recap-empty-inline">当前筛选范围内暂无匹配的财经日程</div>';
      return;
    }

    const grouped = new Map();
    filtered.slice(0, 180).forEach((event, idx) => {
      event._calIdx = idx;
      if (!grouped.has(event.date)) grouped.set(event.date, []);
      grouped.get(event.date).push(event);
    });

    listEl.innerHTML = [...grouped.entries()].map(([date, items]) => `
      <div class="nc-day-group">
        <div class="nc-day-header"><strong>${esc(date)}</strong><span>${items.length} 项日程</span></div>
        <div class="nc-day-events">
          ${items.map(item => {
            const catClass = item.category === 'macro' ? 'macro' : item.category === 'earnings' ? 'earnings' : 'dividend';
            const subNote = item.category === 'macro'
              ? `${item.region ? `${item.region} · ` : ''}${item.time ? `${item.time} · ` : ''}${item.note || ''}`
              : item.category === 'earnings'
                ? `预约披露：${item.reportPeriod || '定期报告'}`
                : `方案：${item.planText || '除权除息'}${item.recordDate ? ` · 股权登记 ${item.recordDate}` : ''}`;
            return `
              <div class="nc-cal-row">
                <span class="nc-cal-badge ${catClass}">${esc(item.kindLabel)}</span>
                <div class="nc-cal-main">
                  <div class="nc-cal-title">
                    ${item.symbol ? `<button class="limit-pool-stock" type="button" onclick="NewsCalendar.openStock('${esc(item.symbol)}','${esc(item.name || item.code)}')">${esc(item.title)}</button>` : `<strong>${esc(item.title)}</strong>`}
                    ${item.code ? trackedBadges(item.code) : ''}
                    ${item.importance === 'high' ? '<span class="sm-tag sm-tag-warn">重点</span>' : ''}
                  </div>
                  <div class="nc-cal-sub">${esc(subNote)}</div>
                </div>
                <button class="sm-action-btn" type="button" onclick="NewsCalendar.addCalByIndex(${item._calIdx})">+ 工作台日历</button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `).join('');
    listEl._filteredEvents = filtered;
  }

  function addCalByIndex(idx) {
    const listEl = document.getElementById('nc-cal-list');
    const item = listEl?._filteredEvents?.[idx];
    if (item) addEventToWorkbench(item.date, item.title, item.kindLabel || '宏观');
  }

  async function loadCalendar(force = false) {
    if (state.calendar.loading && !force) return;
    const requestId = ++state.calendar.requestId;
    state.calendar.loading = true;
    const statusEl = document.getElementById('nc-cal-status');
    const listEl = document.getElementById('nc-cal-list');
    if (statusEl) statusEl.textContent = '正在同步宏观与财报日历…';
    if ((!state.calendar.payload || force) && listEl) {
      listEl.innerHTML = '<div class="module-loading">正在汇总宏观、财报与除权日历</div>';
    }
    try {
      const qs = new URLSearchParams({ days: String(state.calendar.days) });
      if (force) qs.set('refresh', '1');
      const response = await fetch(`/api/financial-calendar?${qs}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '财经日历加载失败');
      if (requestId !== state.calendar.requestId) return;
      state.calendar.payload = payload;
      state.calendar.loaded = true;
      renderCalendar();
    } catch (error) {
      if (requestId !== state.calendar.requestId) return;
      if (statusEl) statusEl.textContent = error.message || '财经日历暂不可用';
      if (listEl) listEl.innerHTML = `<div class="recap-empty-inline">${esc(error.message || '请稍后重试')}<br><button class="refresh-btn" type="button" onclick="NewsCalendar.refreshActive()">重新获取</button></div>`;
    } finally {
      if (requestId === state.calendar.requestId) state.calendar.loading = false;
    }
  }

  function setView(view) {
    if (!['flash', 'calendar'].includes(view)) return;
    state.view = view;
    document.querySelectorAll('[data-nc-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.ncView === view));
    document.querySelectorAll('[data-nc-panel]').forEach(panel => { panel.hidden = panel.dataset.ncPanel !== view; });
    if (view === 'flash' && !state.flash.loaded) loadFlash();
    if (view === 'calendar' && !state.calendar.loaded) loadCalendar();
  }

  function load(force = false, options = {}) {
    if (options.background) {
      if (state.view === 'flash') loadFlash(false, { background: true });
      return;
    }
    setView(state.view);
    if (force) refreshActive();
  }

  function refreshActive() {
    if (state.view === 'flash') loadFlash(true);
    else loadCalendar(true);
  }

  function setChannel(channel) {
    if (!['all', 'focus', 'company', 'global'].includes(channel)) return;
    state.flash.channel = channel;
    document.querySelectorAll('[data-nc-channel]').forEach(btn => btn.classList.toggle('active', btn.dataset.ncChannel === channel));
    loadFlash(true);
  }

  function setOnlyImportant(checked) {
    state.flash.onlyImportant = Boolean(checked);
    renderFlash();
  }

  function setOnlyTracked(checked) {
    state.flash.onlyTracked = Boolean(checked);
    renderFlash();
  }

  function setFlashQuery(query) {
    state.flash.query = String(query || '');
    renderFlash();
  }

  function setCalendarDays(days) {
    const n = Number(days);
    if (![7, 14, 30, 60].includes(n)) return;
    state.calendar.days = n;
    document.querySelectorAll('[data-nc-days]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.ncDays) === n));
    loadCalendar(true);
  }

  function setCalendarFilter(filter) {
    if (!['all', 'macro', 'earnings', 'dividend', 'tracked'].includes(filter)) return;
    state.calendar.filter = filter;
    document.querySelectorAll('[data-nc-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.ncFilter === filter));
    renderCalendar();
  }

  function setCalendarQuery(query) {
    state.calendar.query = String(query || '');
    renderCalendar();
  }

  window.NewsCalendar = {
    load,
    refreshActive,
    setView,
    setChannel,
    setOnlyImportant,
    setOnlyTracked,
    setFlashQuery,
    setCalendarDays,
    setCalendarFilter,
    setCalendarQuery,
    openStock,
    askAiByIndex,
    addCalByIndex,
  };
})();
