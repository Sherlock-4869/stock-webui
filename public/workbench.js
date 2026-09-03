/* Investment workbench: guest-local data with account-scoped cloud synchronization. */
(function () {
  'use strict';
  const GUEST_KEY = 'investment_workbench_v1';
  const USER_KEY_PREFIX = 'investment_workbench_user_';
  const state = {};
  let activeUserId = null;
  let syncTimer = null;
  let lastSynced = '';
  function storageKey() { return activeUserId ? `${USER_KEY_PREFIX}${activeUserId}` : GUEST_KEY; }
  function readLocal(key = storageKey()) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
  function applyState(value) {
    const source = value && typeof value === 'object' ? value : {};
    state.positions = Array.isArray(source.positions) ? source.positions : [];
    state.alerts = Array.isArray(source.alerts) ? source.alerts : [];
    state.events = Array.isArray(source.events) ? source.events : [
      { date: new Date().toISOString().slice(0, 10), title: '今日市场复盘', kind: '复盘' },
      { date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), title: '记录下周观察重点', kind: '研究' },
    ];
    state.trades = Array.isArray(source.trades) ? source.trades : [];
    state.alertNotified = source.alertNotified && typeof source.alertNotified === 'object' ? source.alertNotified : {};
  }
  applyState(readLocal());
  const quotes = {};
  let replayRows = [];
  let activeTrade = null;

  function cloudData() { return { version:1, positions:state.positions, trades:state.trades, alerts:state.alerts, events:state.events }; }
  function save() {
    localStorage.setItem(storageKey(), JSON.stringify({ ...cloudData(), alertNotified:state.alertNotified }));
    if (activeUserId) scheduleSync();
  }
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncToAccount(), 700);
  }
  async function syncToAccount({ force = false } = {}) {
    if (!activeUserId || typeof window.apiRequest !== 'function') return false;
    const data = cloudData(); const serialized = JSON.stringify(data);
    if (!force && serialized === lastSynced) return true;
    try {
      const payload = await window.apiRequest('/api/workbench', { method:'PUT', body:JSON.stringify({ data }) });
      lastSynced = JSON.stringify(payload.data || data);
      return true;
    } catch (_) { return false; }
  }
  async function activateAccount(userId) {
    const normalizedUserId = String(userId || '');
    if (!normalizedUserId) return;
    await syncToAccount({ force:true });
    activeUserId = normalizedUserId;
    lastSynced = '';
    const guestData = readLocal(GUEST_KEY);
    const cachedUserData = readLocal(storageKey());
    try {
      const payload = await window.apiRequest('/api/workbench', { method:'GET', headers:{} });
      const remoteData = payload.data;
      if (remoteData) {
        applyState(remoteData);
        localStorage.setItem(storageKey(), JSON.stringify({ ...remoteData, alertNotified:cachedUserData.alertNotified || {} }));
        lastSynced = JSON.stringify(remoteData);
      } else {
        const initial = cachedUserData.positions?.length || cachedUserData.trades?.length || cachedUserData.alerts?.length || cachedUserData.events?.length ? cachedUserData : guestData;
        applyState(initial);
        save();
        await syncToAccount({ force:true });
        if (initial === guestData && (guestData.positions?.length || guestData.trades?.length || guestData.alerts?.length)) show('已将当前浏览器的投资工作台迁入此账号');
      }
      render(); refreshQuotes();
    } catch (_) {
      applyState(cachedUserData);
      render();
      show('工作台云端同步暂不可用，暂时使用本机副本');
    }
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function money(v) { return Number.isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '--'; }
  function pct(v) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '--'; }
  function normalizeSymbol(value) {
    const raw = String(value || '').trim();
    if (/^\d{6}$/.test(raw)) return /^[56]/.test(raw) ? `sh${raw}` : `sz${raw}`;
    return raw;
  }
  function normalizePrice(value) { const n = num(value); return n > 0 ? Math.round(n * 1000) / 1000 : 0; }
  function esc(v) { return typeof window.escapeHtml === 'function' ? window.escapeHtml(String(v)) : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function parseQuote(text) {
    const out = {};
    String(text).split('\n').forEach(line => { const m = line.match(/^v_([\w.-]+)="([^"]*)"/); if (m) { const f = m[2].split('~'); out[m[1]] = { name: f[1] || m[1], price: num(f[3]), prev: num(f[4]), pct: num(f[32]) }; } });
    return out;
  }
  async function refreshQuotes() {
    const symbols = [...new Set(state.positions.map(p => p.symbol).filter(Boolean))];
    if (!symbols.length) { render(); return; }
    try {
      const response = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!response.ok) throw new Error('quote unavailable');
      Object.assign(quotes, parseQuote(await response.text()));
      render();
    } catch (_) { const note = document.getElementById('wb-alert-note'); if (note) note.textContent = '交易已保存 · 实时行情暂不可用，稍后可重试'; }
  }
  function show(message) { if (typeof window.showToast === 'function') window.showToast(message, false); }
  function rebuildPositionsFromTrades() {
    if (!state.trades.length) { state.positions = []; return; }
    const positions = [];
    state.trades.forEach(trade => {
      const symbol = normalizeSymbol(trade.symbol); const quantity = num(trade.quantity); const price = normalizePrice(trade.price); if (!symbol || quantity <= 0 || price <= 0) return;
      const existing = positions.find(item => item.symbol === symbol); const side = String(trade.side || '').toLowerCase();
      if (side === 'sell') {
        if (!existing) return;
        existing.quantity = Math.max(0, existing.quantity - quantity);
        if (!existing.quantity) positions.splice(positions.indexOf(existing), 1);
      } else if (existing) {
        const total = existing.quantity + quantity; existing.cost = (existing.cost * existing.quantity + price * quantity) / total; existing.quantity = total;
      } else positions.push({ symbol, name: String(trade.name || symbol), quantity, cost: price });
    });
    const oldOrder = state.positions.map(item => item.symbol); positions.forEach(position => { const old = state.positions.find(item => item.symbol === position.symbol); if (old?.lastPrice) position.lastPrice = old.lastPrice; });
    positions.sort((a, b) => { const ai = oldOrder.indexOf(a.symbol); const bi = oldOrder.indexOf(b.symbol); return (ai < 0 ? oldOrder.length : ai) - (bi < 0 ? oldOrder.length : bi); });
    state.positions = positions;
  }
  function recordTrade({ symbol: rawSymbol, name = '', quantity: rawQuantity, cost: rawCost, side = 'buy' }) {
    const symbol = normalizeSymbol(rawSymbol); const quantity = num(rawQuantity); const cost = normalizePrice(rawCost);
    if (!symbol || quantity <= 0 || cost <= 0) return false;
    const old = state.positions.find(p => p.symbol === symbol);
    if (side === 'sell') { if (!old) { show('没有可卖出的持仓'); return false; } if (quantity > old.quantity) { show(`卖出数量不能超过当前持仓（${old.quantity}）`); return false; } old.quantity = Math.max(0, old.quantity - quantity); if (!old.quantity) state.positions = state.positions.filter(p => p !== old); }
    else if (old) { const total = old.quantity + quantity; old.cost = (old.cost * old.quantity + cost * quantity) / total; old.quantity = total; if (!old.name) old.name = String(name || symbol); }
    else state.positions.push({ symbol, name: String(name || symbol), quantity, cost });
    state.trades.push({ at: Date.now(), symbol, name: String(name || old?.name || symbol), side: side.toUpperCase(), quantity, price: cost }); save(); show('交易已保存'); refreshQuotes();
    return true;
  }
  function addPosition(event) {
    event.preventDefault(); const f = new FormData(event.target);
    recordTrade({ symbol:f.get('symbol'), name:f.get('name'), quantity:f.get('quantity'), cost:f.get('cost'), side:f.get('side') || 'buy' }); event.target.reset();
  }
  function openTrade(symbol, name, side) {
    activeTrade = { symbol: normalizeSymbol(symbol), name: String(name || symbol), side: side === 'sell' ? 'sell' : 'buy' };
    const mask = document.getElementById('trade-mask');
    const dialog = document.getElementById('trade-dialog');
    const title = document.getElementById('trade-title');
    const stock = document.getElementById('trade-stock');
    const symbolInput = document.getElementById('trade-symbol');
    const nameInput = document.getElementById('trade-name');
    const sideInput = document.getElementById('trade-side');
    const quantity = document.getElementById('trade-quantity');
    const price = document.getElementById('trade-price');
    const submit = document.getElementById('trade-submit');
    const hint = document.getElementById('trade-price-hint');
    if (!mask || !quantity || !price) return;
    if (dialog) dialog.classList.toggle('sell', activeTrade.side === 'sell');
    if (title) title.textContent = activeTrade.side === 'sell' ? '模拟卖出' : '模拟买入';
    if (stock) stock.textContent = `${activeTrade.name} · ${activeTrade.symbol}`;
    if (symbolInput) symbolInput.value = activeTrade.symbol;
    if (nameInput) nameInput.value = activeTrade.name;
    if (sideInput) sideInput.value = activeTrade.side;
    quantity.value = '';
    price.value = '';
    if (hint) hint.textContent = '价格不会自动跟随行情成交，可手动输入模拟成交价。';
    if (submit) { submit.textContent = activeTrade.side === 'sell' ? '确认卖出' : '确认买入'; submit.classList.toggle('sell-action', activeTrade.side === 'sell'); submit.classList.toggle('buy-action', activeTrade.side !== 'sell'); }
    mask.classList.add('open');
    window.setTimeout(() => quantity.focus(), 30);
  }
  async function fillRealtimePrice() {
    const symbol = document.getElementById('trade-symbol')?.value || activeTrade?.symbol;
    const input = document.getElementById('trade-price');
    const hint = document.getElementById('trade-price-hint');
    const button = document.getElementById('trade-fetch-price');
    if (!symbol || !input) return;
    if (button) { button.disabled = true; button.textContent = '获取中…'; }
    try {
      let quote = quotes[symbol];
      if (!quote?.price) {
        const response = await fetch(`/api/quote?symbols=${encodeURIComponent(symbol)}`);
        if (!response.ok) throw new Error('quote unavailable');
        quote = parseQuote(await response.text())[symbol];
        if (quote) quotes[symbol] = quote;
      }
      if (!quote?.price) throw new Error('price unavailable');
      input.value = quote.price.toFixed(3);
      if (hint) hint.textContent = `已填入实时价 ${quote.price.toFixed(3)}；确认后按该价格模拟成交。`;
    } catch (_) {
      if (hint) hint.textContent = '暂时获取不到实时价，请手动输入成交价。';
    } finally {
      if (button) { button.disabled = false; button.textContent = '获取实时股价'; }
    }
  }
  function submitTrade(event) {
    event.preventDefault();
    const ok = recordTrade({ symbol: document.getElementById('trade-symbol')?.value, name: document.getElementById('trade-name')?.value, side: document.getElementById('trade-side')?.value, quantity: document.getElementById('trade-quantity')?.value, cost: document.getElementById('trade-price')?.value });
    if (ok) closeTradeDialog();
  }
  function closeTradeDialog(event) {
    if (event && (event.target !== event.currentTarget || event.currentTarget?.dataset.pointerStartedOnMask !== 'true')) return;
    document.getElementById('trade-mask')?.classList.remove('open');
    activeTrade = null;
  }
  function openAlert(symbol, name) {
    const normalized = normalizeSymbol(symbol);
    const mask = document.getElementById('alert-mask');
    if (!mask || !normalized) return;
    document.getElementById('alert-symbol').value = normalized;
    document.getElementById('alert-name').value = String(name || symbol || normalized);
    document.getElementById('alert-stock').textContent = `${String(name || symbol || normalized)} · ${normalized}`;
    document.getElementById('alert-target').value = '';
    document.getElementById('alert-type').value = 'above';
    mask.classList.add('open');
    window.setTimeout(() => document.getElementById('alert-target')?.focus(), 30);
  }
  function submitAlert(event) {
    event.preventDefault();
    const target = num(document.getElementById('alert-target')?.value);
    const symbol = document.getElementById('alert-symbol')?.value;
    const type = document.getElementById('alert-type')?.value;
    if (!symbol || target <= 0 || !['above', 'below'].includes(type)) { show('请输入有效的目标价格'); return; }
    state.alerts.push({ symbol: normalizeSymbol(symbol), name: document.getElementById('alert-name')?.value || '', type, target: normalizePrice(target), active: true });
    save(); render(); show('预警规则已保存'); closeAlertDialog();
  }
  function closeAlertDialog(event) {
    if (event && (event.target !== event.currentTarget || event.currentTarget?.dataset.pointerStartedOnMask !== 'true')) return;
    document.getElementById('alert-mask')?.classList.remove('open');
  }
  function ruleName(rule) { return String(rule.name || quotes[rule.symbol]?.name || rule.symbol || ''); }
  function removePosition(index) {
    const position = state.positions[index]; if (!position) return;
    if (!window.confirm(`删除 ${position.name || position.symbol} 持仓及其全部操作记录吗？`)) return;
    state.positions.splice(index, 1);
    state.trades = state.trades.filter(trade => normalizeSymbol(trade.symbol) !== position.symbol);
    save(); render(); show('持仓及对应操作记录已删除');
  }
  function removeTrade(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.trades.length) return;
    if (!window.confirm('删除这条买卖记录后，将按剩余记录重新计算持仓。确定继续吗？')) return;
    state.trades.splice(index, 1); rebuildPositionsFromTrades(); save(); render(); refreshQuotes(); show('操作记录已删除，持仓已刷新');
  }
  function addAlert(event) { event.preventDefault(); const f = new FormData(event.target); const symbol = normalizeSymbol(f.get('symbol')); state.alerts.push({ symbol, name: String(f.get('name') || quotes[symbol]?.name || ''), type: f.get('type'), target: normalizePrice(f.get('target')), active: true }); save(); event.target.reset(); render(); }
  function removeAlert(index) { state.alerts.splice(index, 1); save(); render(); }
  function addEvent(event) { event.preventDefault(); const f = new FormData(event.target); state.events.push({ date: f.get('date'), title: String(f.get('title') || '').trim(), kind: f.get('kind') }); state.events.sort((a, b) => a.date.localeCompare(b.date)); save(); event.target.reset(); render(); }
  function removeEvent(index) { state.events.splice(index, 1); save(); render(); }
  function evaluateAlerts() { return state.alerts.filter(a => { const q = quotes[a.symbol]; return q && ((a.type === 'above' && q.price >= a.target) || (a.type === 'below' && q.price <= a.target)); }); }
  let draggedPositionSymbol = '';
  function bindPositionDrag(body) {
    body.querySelectorAll('tr[data-position-symbol]').forEach(row => {
      row.addEventListener('dragstart', event => { draggedPositionSymbol = row.dataset.positionSymbol; row.classList.add('workbench-dragging'); event.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { draggedPositionSymbol = ''; row.classList.remove('workbench-dragging'); body.querySelectorAll('.workbench-drag-over').forEach(item => item.classList.remove('workbench-drag-over')); });
      row.addEventListener('dragover', event => { event.preventDefault(); if (row.dataset.positionSymbol !== draggedPositionSymbol) row.classList.add('workbench-drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('workbench-drag-over'));
      row.addEventListener('drop', event => { event.preventDefault(); row.classList.remove('workbench-drag-over'); const from = state.positions.findIndex(item => item.symbol === draggedPositionSymbol); const to = state.positions.findIndex(item => item.symbol === row.dataset.positionSymbol); if (from < 0 || to < 0 || from === to) return; const [moved] = state.positions.splice(from, 1); state.positions.splice(to, 0, moved); save(); render(); });
    });
  }
  function notifyTriggeredAlerts() {
    if (!window.Inbox?.pushAlert || !window.currentUser) return;
    const today = new Date().toISOString().slice(0, 10);
    state.alerts.forEach(rule => {
      const q = quotes[rule.symbol]; const key = `${today}:${rule.symbol}:${rule.type}:${rule.target}`;
      if (!q || state.alertNotified[key] || !((rule.type === 'above' && q.price >= rule.target) || (rule.type === 'below' && q.price <= rule.target))) return;
      state.alertNotified[key] = true; save(); window.Inbox.pushAlert({ title:`价格预警 · ${ruleName(rule)}`, content:`${ruleName(rule)}（${rule.symbol}）当前价格 ${q.price.toFixed(3)}，已${rule.type === 'above' ? '高于' : '低于'}设定价 ${rule.target.toFixed(3)}。` });
    });
  }
  function render() {
    const grid = document.querySelector('#page-workbench .workbench-grid');
    if (grid && !document.getElementById('wb-today-profit')) {
      const card = document.createElement('div'); card.className = 'workbench-card'; card.innerHTML = '<label>今日盈亏</label><b id="wb-today-profit">--</b><small>按昨收与持仓量估算</small>'; grid.appendChild(card);
    }
    const positionsBody = document.getElementById('wb-positions');
    const rows = state.positions.map((p, i) => { const q = quotes[p.symbol] || {}; const price = q.price || p.lastPrice || p.cost; const value = price * p.quantity; const profit = (price - p.cost) * p.quantity; return { p, i, price, value, profit, q }; });
    rows.forEach(r => { r.p.lastPrice = r.price; if (r.q.name && r.p.name === r.p.symbol) r.p.name = r.q.name; });
    state.trades.forEach(trade => { if (!trade.name) trade.name = quotes[trade.symbol]?.name || state.positions.find(position => position.symbol === trade.symbol)?.name || trade.symbol; }); save();
    const cost = rows.reduce((s, r) => s + r.p.cost * r.p.quantity, 0); const value = rows.reduce((s, r) => s + r.value, 0); const profit = value - cost; const maxWeight = value ? Math.max(...rows.map(r => r.value / value), 0) * 100 : 0;
    const todayRows = rows.filter(r => Number.isFinite(r.q.prev) && r.q.prev > 0);
    const todayProfit = todayRows.reduce((s, r) => s + (r.price - r.q.prev) * r.p.quantity, 0);
    const set = (id, text, cls) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.className = cls ? `workbench-${cls}` : ''; } };
    set('wb-market-value', value ? money(value) : '--'); set('wb-cost-value', `成本 ${cost ? money(cost) : '--'}`); set('wb-profit', value ? `${profit >= 0 ? '+' : ''}${money(profit)}` : '--', profit >= 0 ? 'positive' : 'negative'); set('wb-profit-rate', `收益率 ${cost ? pct(profit / cost * 100) : '--'}`); set('wb-concentration', value ? `${maxWeight.toFixed(1)}%` : '--'); set('wb-concentration-note', rows.length ? `${rows.length} 个持仓` : '尚无持仓'); set('wb-alert-count', String(evaluateAlerts().length));
    set('wb-today-profit', todayRows.length ? `${todayProfit >= 0 ? '+' : ''}${money(todayProfit)}` : '--', todayProfit > 0 ? 'positive' : todayProfit < 0 ? 'negative' : 'muted');
    const body = positionsBody; if (body) { body.innerHTML = rows.length ? rows.map(r => `<tr draggable="true" data-position-symbol="${esc(r.p.symbol)}"><td><span class="workbench-drag-handle" title="拖动调整顺序">⠿</span>${esc(r.p.symbol)}</td><td><strong>${esc(r.p.name)}</strong></td><td>${money(r.p.quantity)}</td><td>${r.p.cost.toFixed(3)}</td><td>${r.price.toFixed(3)}</td><td>${money(r.value)}</td><td class="${r.profit >= 0 ? 'workbench-positive' : 'workbench-negative'}">${r.profit >= 0 ? '+' : ''}${money(r.profit)}</td><td><button type="button" onclick="InvestmentWorkbench.removePosition(${r.i})">删除</button></td></tr>`).join('') : '<tr><td colspan="8" class="workbench-empty">还没有模拟持仓，先记录一笔买入</td></tr>'; bindPositionDrag(body); }
    const alertEl = document.getElementById('wb-alerts'); if (alertEl) alertEl.innerHTML = state.alerts.length ? state.alerts.map((a, i) => { const q = quotes[a.symbol]; const hit = evaluateAlerts().includes(a); return `<div class="workbench-item"><span><strong>${esc(ruleName(a))}</strong><small>${esc(a.symbol)} · ${a.type === 'above' ? '价格高于' : '价格低于'} ${money(a.target)} · 当前 ${q ? money(q.price) : '--'}</small></span><span class="${hit ? 'workbench-positive' : 'workbench-muted'}">${hit ? '已触发' : '等待'} <button type="button" onclick="InvestmentWorkbench.removeAlert(${i})">✕</button></span></div>`; }).join('') : '<div class="workbench-empty">添加价格条件后，刷新估值会自动检查</div>';
    const eventEl = document.getElementById('wb-events'); if (eventEl) eventEl.innerHTML = state.events.length ? state.events.map((e, i) => `<div class="workbench-item"><span><strong>${esc(e.title)}</strong><small>${esc(e.kind)} · ${esc(e.date)}</small></span><button type="button" onclick="InvestmentWorkbench.removeEvent(${i})">✕</button></div>`).join('') : '<div class="workbench-empty">暂无事件</div>';
    const tradesEl = document.getElementById('wb-trades'); if (tradesEl) { const tradeRows = state.trades.map((trade, index) => ({ trade, index })).sort((a, b) => num(b.trade.at) - num(a.trade.at) || b.index - a.index); tradesEl.innerHTML = tradeRows.length ? tradeRows.map(({ trade: t, index }) => { const side = String(t.side || '').toLowerCase() === 'sell'; const timestamp = num(t.at); const time = timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--'; return `<div class="workbench-item trade-record"><span><strong class="${side ? 'workbench-negative' : 'workbench-positive'}">${side ? '卖出' : '买入'} · ${esc(t.name || t.symbol)}</strong><small>${esc(t.symbol)} · ${time} · ${money(num(t.quantity))} 股 · ${num(t.price).toFixed(3)}</small></span><button type="button" title="删除后按剩余记录重算持仓" onclick="InvestmentWorkbench.removeTrade(${index})">删除</button></div>`; }).join('') : '<div class="workbench-empty">暂无买卖操作记录</div>'; }
    const select = document.getElementById('wb-replay-symbol'); if (select) { const current = select.value; select.innerHTML = rows.length ? rows.map(r => `<option value="${esc(r.p.symbol)}">${esc(r.p.name)} · ${esc(r.p.symbol)}</option>`).join('') : '<option value="">先添加持仓</option>'; if (rows.some(r => r.p.symbol === current)) select.value = current; }
    replay();
    notifyTriggeredAlerts();
  }
  async function replay() {
    const symbol = document.getElementById('wb-replay-symbol')?.value; if (!symbol) { draw([]); return; }
    try { const response = await fetch(`/api/kline?sym=${encodeURIComponent(symbol)}`); if (!response.ok) throw new Error(); const payload = await response.json(); const root = payload.data?.[symbol] || Object.values(payload.data || {})[0] || {}; const key = Object.keys(root).find(k => /day$/i.test(k)); replayRows = (root[key] || []).map(r => ({ date: r[0], close: num(r[2] ?? r[4] ?? r.close) })).filter(r => r.close > 0).slice(-120); draw(replayRows); } catch (_) { replayRows = []; draw([]); }
  }
  function draw(rows) { const canvas = document.getElementById('wb-chart'); if (!canvas) return; const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; canvas.width = Math.max(300, rect.width * dpr); canvas.height = Math.max(120, rect.height * dpr); const c = canvas.getContext('2d'); c.scale(dpr, dpr); const w = rect.width, h = rect.height; c.clearRect(0, 0, w, h); if (!rows.length) { c.fillStyle = '#8b949e'; c.font = '12px sans-serif'; c.fillText('暂无日 K 数据', 14, 28); return; } const vals = rows.map(r => r.close), min = Math.min(...vals), max = Math.max(...vals), pad = 14; c.strokeStyle = '#58a6ff'; c.lineWidth = 2; c.beginPath(); rows.forEach((r, i) => { const x = pad + i * (w - pad * 2) / Math.max(1, rows.length - 1); const y = h - pad - (r.close - min) / Math.max(0.0001, max - min) * (h - pad * 2); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); c.fillStyle = '#8b949e'; c.font = '10px sans-serif'; c.fillText(`${money(min)} — ${money(max)}`, 14, 14); }
  function runBacktest() { if (replayRows.length < 25) { show('至少需要 25 个交易日数据才能回测'); return; } let cash = 1, shares = 0, trades = 0; for (let i = 20; i < replayRows.length; i += 1) { const fast = replayRows.slice(i - 5, i).reduce((s, r) => s + r.close, 0) / 5; const slow = replayRows.slice(i - 20, i).reduce((s, r) => s + r.close, 0) / 20; if (!shares && fast > slow) { shares = cash / replayRows[i].close; cash = 0; trades++; } else if (shares && fast < slow) { cash = shares * replayRows[i].close; shares = 0; trades++; } } const final = cash + shares * replayRows.at(-1).close; const result = document.getElementById('wb-backtest-result'); if (result) result.textContent = `5/20 日均线简化回测：初始净值 1.00 → ${final.toFixed(3)}，收益 ${pct((final - 1) * 100)}，交易 ${trades} 次（未计费用和滑点）`; }
  function exportData() { const lines = [['symbol', 'name', 'quantity', 'cost', 'lastPrice', 'marketValue'], ...state.positions.map(p => [p.symbol, p.name, p.quantity, p.cost, p.lastPrice || '', (p.lastPrice || p.cost) * p.quantity]), [], ['alerts'], ['symbol', 'type', 'target'], ...state.alerts.map(a => [a.symbol, a.type, a.target]), [], ['events'], ['date', 'kind', 'title'], ...state.events.map(e => [e.date, e.kind, e.title])]; const csv = lines.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'); const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `investment-workbench-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href); }
  function openResearch() { const symbol = document.getElementById('wb-replay-symbol')?.value; if (symbol && typeof window.openModal === 'function') window.openModal(symbol); else show('请先添加并选择一个持仓'); }
  function aiSummary() { const p = state.positions.map(x => `${x.name}(${x.symbol}) ${x.quantity}股，成本${x.cost}`).join('；'); const input = document.getElementById('ai-message-input'); if (typeof window.switchAppPage === 'function' && window.hasAiMenuAccess?.()) { window.switchAppPage('ai'); setTimeout(() => { if (input) input.value = `请基于我的模拟持仓生成研究摘要，列出基本面、估值、催化剂和风险：${p || '目前没有持仓'}`; }, 50); } else show('请先开启 AI 问股权限'); }
  window.InvestmentWorkbench = { render, refreshQuotes, addPosition, recordTrade, openTrade, submitTrade, fillRealtimePrice, closeTradeDialog, openAlert, submitAlert, removePosition, removeTrade, addAlert, removeAlert, addEvent, removeEvent, replay, runBacktest, exportData, aiSummary, openResearch, activateAccount, flushSync:() => syncToAccount({ force:true }) };
  window.addEventListener('resize', () => { if (document.getElementById('page-workbench')?.classList.contains('active')) draw(replayRows); });
  window.setInterval(() => { if (window.currentUser && state.positions.length) refreshQuotes(); }, 15000);
  render();
})();
