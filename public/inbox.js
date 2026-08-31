(function () {
  'use strict';
  function esc(value) { return typeof window.escapeHtml === 'function' ? window.escapeHtml(String(value ?? '')) : String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
  function fmt(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', { hour12:false }); }
  function setBadge(count) { const badge = document.getElementById('inbox-badge'); if (badge) badge.textContent = String(Math.max(0, Number(count) || 0)); }
  function setStatus(text, error = false) { const el = document.getElementById('inbox-status'); if (el) { el.textContent = text; el.style.color = error ? '#ff7b72' : ''; } }
  async function request(path, options = {}) { const response = await fetch(path, { ...options, headers:{ 'Content-Type':'application/json', ...(options.headers || {}) } }); let payload = {}; try { payload = await response.json(); } catch (_) {} if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`); return payload; }
  async function refresh() {
    if (!window.currentUser) { setStatus('登录后查看消息'); const list = document.getElementById('inbox-list'); if (list) list.innerHTML = '<div class="inbox-empty">请先登录，再查看站内消息</div>'; setBadge(0); return; }
    try { const payload = await request('/api/inbox?limit=100', { method:'GET', headers:{} }); const messages = Array.isArray(payload.messages) ? payload.messages : []; setBadge(payload.unreadCount); setStatus(`${messages.length} 条消息 · 未读 ${payload.unreadCount || 0}`); const list = document.getElementById('inbox-list'); if (list) list.innerHTML = messages.length ? messages.map(message => `<article class="inbox-message${message.isRead ? '' : ' unread'}" data-id="${esc(message.id)}"><div class="inbox-message-head"><span class="inbox-message-title">${esc(message.title)}</span><span class="inbox-message-meta">${esc(fmt(message.createdAt))}${message.isRead ? '' : ' · 未读'}</span></div><div class="inbox-message-content">${esc(message.content)}</div></article>`).join('') : '<div class="inbox-empty">暂无站内消息</div>'; }
    catch (error) { setStatus(error.message || '消息加载失败', true); }
  }
  async function markAllRead() { if (!window.currentUser) return; try { await request('/api/inbox/read', { method:'PUT', body:'{}' }); await refresh(); } catch (error) { setStatus(error.message || '操作失败', true); } }
  async function pushAlert({ title, content }) { if (!window.currentUser) return false; try { await request('/api/inbox/alerts', { method:'POST', body:JSON.stringify({ title, content }) }); if (document.getElementById('page-inbox')?.classList.contains('active')) await refresh(); return true; } catch (_) { return false; } }
  async function adminRefresh() {
    if (!window.currentUser?.isAdmin) return;
    try { const payload = await request('/api/admin/inbox', { method:'GET', headers:{} }); const list = document.getElementById('inbox-admin-list'); const messages = Array.isArray(payload.messages) ? payload.messages : []; if (list) list.innerHTML = messages.length ? messages.map(message => `<div class="admin-inbox-item"><div><strong>${esc(message.title)}</strong><small>${esc(fmt(message.createdAt))} · ${esc(message.content)}</small></div><button class="dialog-btn danger" type="button" onclick="Inbox.adminDelete('${esc(message.id)}')">删除</button></div>`).join('') : '<div class="inbox-empty">暂无已发送消息</div>'; }
    catch (error) { const el = document.getElementById('inbox-admin-status'); if (el) el.textContent = error.message || '加载失败'; }
  }
  async function adminSend(event) { event.preventDefault(); const form = event.target; const body = { title:form.title.value, content:form.content.value }; const status = document.getElementById('inbox-admin-status'); try { const payload = await request('/api/admin/inbox', { method:'POST', body:JSON.stringify(body) }); if (status) status.textContent = `已向 ${payload.sent || 0} 个启用账号推送`; form.reset(); await adminRefresh(); } catch (error) { if (status) status.textContent = error.message || '推送失败'; } }
  async function adminDelete(id) { if (!window.confirm('确定删除这条站内消息吗？')) return; try { await request(`/api/admin/inbox/${encodeURIComponent(id)}`, { method:'DELETE', body:'{}' }); await adminRefresh(); } catch (error) { window.alert(error.message || '删除失败'); } }
  window.Inbox = { refresh, markAllRead, pushAlert, adminRefresh, adminSend, adminDelete };
  window.setInterval(() => { if (window.currentUser) refresh(); }, 15000);
})();
