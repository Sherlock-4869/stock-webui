/* Investment workbench: a browser-local portfolio, alert, replay and backtest MVP. */
(function () {
  'use strict';
  const KEY = 'investment_workbench_v1';
  const state = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } })();
  state.positions = Array.isArray(state.positions) ? state.positions : [];
  state.alerts = Array.isArray(state.alerts) ? state.alerts : [];
  state.events = Array.isArray(state.events) ? state.events : [
    { date: new Date().toISOString().slice(0, 10), title: '今日市场复盘', kind: '复盘' },
    { date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), title: '记录下周观察重点', kind: '研究' },
  ];
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  const quotes = {};
  let replayRows = [];

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
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
  function recordTrade({ symbol: rawSymbol, name = '', quantity: rawQuantity, cost: rawCost, side = 'buy' }) {
    const symbol = normalizeSymbol(rawSymbol); const quantity = num(rawQuantity); const cost = normalizePrice(rawCost);
    if (!symbol || quantity <= 0 || cost <= 0) return false;
    const old = state.positions.find(p => p.symbol === symbol);
    if (side === 'sell') { if (!old) { show('没有可卖出的持仓'); return false; } if (quantity > old.quantity) { show(`卖出数量不能超过当前持仓（${old.quantity}）`); return false; } old.quantity = Math.max(0, old.quantity - quantity); if (!old.quantity) state.positions = state.positions.filter(p => p !== old); }
    else if (old) { const total = old.quantity + quantity; old.cost = (old.cost * old.quantity + cost * quantity) / total; old.quantity = total; if (!old.name) old.name = String(name || symbol); }
    else state.positions.push({ symbol, name: String(name || symbol), quantity, cost });
    state.trades.push({ at: Date.now(), symbol, side: side.toUpperCase(), quantity, price: cost }); save(); show('交易已保存'); refreshQuotes();
    return true;
  }
  function addPosition(event) {
    event.preventDefault(); const f = new FormData(event.target);
    recordTrade({ symbol:f.get('symbol'), name:f.get('name'), quantity:f.get('quantity'), cost:f.get('cost'), side:f.get('side') || 'buy' }); event.target.reset();
  }
  function openTrade(symbol, name, side) {
    const quantity = window.prompt(`${side === 'sell' ? '模拟卖出' : '模拟买入'} ${name || symbol}\n请输入数量`);
    if (quantity == null) return;
    const cost = window.prompt('请输入成交价（正数，最多 3 位小数）');
    if (cost == null) return;
    recordTrade({ symbol, name, quantity, cost, side });
  }
  function removePosition(index) { state.positions.splice(index, 1); save(); render(); }
  function addAlert(event) { event.preventDefault(); const f = new FormData(event.target); state.alerts.push({ symbol: normalizeSymbol(f.get('symbol')), type: f.get('type'), target: num(f.get('target')), active: true }); save(); event.target.reset(); render(); }
  function removeAlert(index) { state.alerts.splice(index, 1); save(); render(); }
  function addEvent(event) { event.preventDefault(); const f = new FormData(event.target); state.events.push({ date: f.get('date'), title: String(f.get('title') || '').trim(), kind: f.get('kind') }); state.events.sort((a, b) => a.date.localeCompare(b.date)); save(); event.target.reset(); render(); }
  function removeEvent(index) { state.events.splice(index, 1); save(); render(); }
  function evaluateAlerts() { return state.alerts.filter(a => { const q = quotes[a.symbol]; return q && ((a.type === 'above' && q.price >= a.target) || (a.type === 'below' && q.price <= a.target)); }); }
  function render() {
    const rows = state.positions.map((p, i) => { const q = quotes[p.symbol] || {}; const price = q.price || p.lastPrice || p.cost; const value = price * p.quantity; const profit = (price - p.cost) * p.quantity; return { p, i, price, value, profit, q }; });
    rows.forEach(r => { r.p.lastPrice = r.price; if (r.q.name && r.p.name === r.p.symbol) r.p.name = r.q.name; }); save();
    const cost = rows.reduce((s, r) => s + r.p.cost * r.p.quantity, 0); const value = rows.reduce((s, r) => s + r.value, 0); const profit = value - cost; const maxWeight = value ? Math.max(...rows.map(r => r.value / value), 0) * 100 : 0;
    const set = (id, text, cls) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.className = cls ? `workbench-${cls}` : ''; } };
    set('wb-market-value', value ? money(value) : '--'); set('wb-cost-value', `成本 ${cost ? money(cost) : '--'}`); set('wb-profit', value ? `${profit >= 0 ? '+' : ''}${money(profit)}` : '--', profit >= 0 ? 'positive' : 'negative'); set('wb-profit-rate', `收益率 ${cost ? pct(profit / cost * 100) : '--'}`); set('wb-concentration', value ? `${maxWeight.toFixed(1)}%` : '--'); set('wb-concentration-note', rows.length ? `${rows.length} 个持仓` : '尚无持仓'); set('wb-alert-count', String(evaluateAlerts().length));
    const body = document.getElementById('wb-positions'); if (body) body.innerHTML = rows.length ? rows.map(r => `<tr><td>${esc(r.p.symbol)}</td><td><strong>${esc(r.p.name)}</strong></td><td>${money(r.p.quantity)}</td><td>${r.p.cost.toFixed(3)}</td><td>${r.price.toFixed(3)}</td><td>${money(r.value)}</td><td class="${r.profit >= 0 ? 'workbench-positive' : 'workbench-negative'}">${r.profit >= 0 ? '+' : ''}${money(r.profit)}</td><td><button type="button" onclick="InvestmentWorkbench.removePosition(${r.i})">删除</button></td></tr>`).join('') : '<tr><td colspan="8" class="workbench-empty">还没有模拟持仓，先记录一笔买入</td></tr>';
    const alertEl = document.getElementById('wb-alerts'); if (alertEl) alertEl.innerHTML = state.alerts.length ? state.alerts.map((a, i) => { const q = quotes[a.symbol]; const hit = evaluateAlerts().includes(a); return `<div class="workbench-item"><span><strong>${esc(a.symbol)}</strong><small>${a.type === 'above' ? '价格高于' : '价格低于'} ${money(a.target)} · 当前 ${q ? money(q.price) : '--'}</small></span><span class="${hit ? 'workbench-positive' : 'workbench-muted'}">${hit ? '已触发' : '等待'} <button type="button" onclick="InvestmentWorkbench.removeAlert(${i})">✕</button></span></div>`; }).join('') : '<div class="workbench-empty">添加价格条件后，刷新估值会自动检查</div>';
    const eventEl = document.getElementById('wb-events'); if (eventEl) eventEl.innerHTML = state.events.length ? state.events.map((e, i) => `<div class="workbench-item"><span><strong>${esc(e.title)}</strong><small>${esc(e.kind)} · ${esc(e.date)}</small></span><button type="button" onclick="InvestmentWorkbench.removeEvent(${i})">✕</button></div>`).join('') : '<div class="workbench-empty">暂无事件</div>';
    const select = document.getElementById('wb-replay-symbol'); if (select) { const current = select.value; select.innerHTML = rows.length ? rows.map(r => `<option value="${esc(r.p.symbol)}">${esc(r.p.name)} · ${esc(r.p.symbol)}</option>`).join('') : '<option value="">先添加持仓</option>'; if (rows.some(r => r.p.symbol === current)) select.value = current; }
    replay();
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
  window.InvestmentWorkbench = { render, refreshQuotes, addPosition, recordTrade, openTrade, removePosition, addAlert, removeAlert, addEvent, removeEvent, replay, runBacktest, exportData, aiSummary, openResearch };
  window.addEventListener('resize', () => { if (document.getElementById('page-workbench')?.classList.contains('active')) draw(replayRows); });
  render();
})();
