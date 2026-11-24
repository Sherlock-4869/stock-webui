/* Administrator Consoles: WeChat IPO Push Management & System Health / Upstream Monitor */
(function () {
  'use strict';

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function fmtTime(value) {
    if (!value) return '--';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-CN', { hour12: false });
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 MB';
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时 ${mins}分`;
    if (hours > 0) return `${hours}小时 ${mins}分`;
    return `${mins}分 ${s % 60}秒`;
  }

  function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
  }

  async function adminApi(path, options = {}) {
    if (typeof window.apiRequest === 'function') {
      return window.apiRequest(path, options);
    }
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  }

  // =========================================================================
  // 9. Admin WeChat Console
  // =========================================================================
  const wechatState = {
    overview: null,
    selectedJobId: '',
    jobDetail: null,
    previewText: '',
    previewTitle: '',
    busy: false,
  };

  const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  function renderWechat() {
    const data = wechatState.overview;
    const summaryEl = document.getElementById('admin-wechat-summary');
    const configEl = document.getElementById('admin-wechat-config');
    const jobsEl = document.getElementById('admin-wechat-jobs');
    const detailEl = document.getElementById('admin-wechat-detail');
    if (!data) return;

    const statusBadge = !data.enabled
      ? '<span class="admin-user-state">未启用</span>'
      : data.ready
        ? '<span class="admin-user-state granted">运行就绪</span>'
        : '<span class="sm-tag sm-tag-warn">初始化异常</span>';

    if (summaryEl) {
      const sub = data.subscribers || {};
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">公众号服务状态</div><div class="metric-value" style="font-size:18px">${statusBadge}</div><div class="metric-note">${esc(data.error || (data.enabled ? '回调与定时调度已挂载' : 'STOCK_WECHAT_ENABLED=false'))}</div></div>
        <div class="metric-card"><div class="metric-label">累计关注记录</div><div class="metric-value">${sub.total ?? '--'}</div><div class="metric-note">MySQL 关注者表总计</div></div>
        <div class="metric-card"><div class="metric-label">当前关注中</div><div class="metric-value">${sub.subscribed ?? '--'}</div><div class="metric-note">未取关有效用户</div></div>
        <div class="metric-card"><div class="metric-label">开启打新提醒</div><div class="metric-value up">${sub.enabled ?? '--'}</div><div class="metric-note">定时推送实际目标数</div></div>
      `;
    }

    if (configEl) {
      const sch = data.schedule || {};
      const daily = sch.dailyIpo || {};
      const pad = n => String(n ?? 0).padStart(2, '0');
      const menuButtons = (data.defaultMenu?.button || []).map(btn =>
        btn.sub_button
          ? `${esc(btn.name)}（${btn.sub_button.map(s => esc(s.name)).join(' / ')}）`
          : `${esc(btn.name)}（跳转页面）`
      ).join(' · ');
      configEl.innerHTML = `
        <div class="adm-kv-grid">
          <div><label>调度时区</label><strong>${esc(sch.timezone || 'Asia/Shanghai')}</strong></div>
          <div><label>每周打新汇总</label><strong>每${esc(WEEKDAY_NAMES[sch.weekday] || sch.weekday)} ${pad(sch.hour)}:${pad(sch.minute)}</strong></div>
          <div><label>每日申购提醒</label><strong>${daily.enabled ? `每日 ${pad(daily.hour)}:${pad(daily.minute)}` : '已关闭'}</strong></div>
          <div><label>错过窗口自动补发</label><strong>${sch.catchup ? '开启' : '关闭'} · 新关注默认${data.autoEnable ? '开启' : '关闭'}提醒</strong></div>
          <div class="wide"><label>自定义菜单结构</label><strong>${menuButtons || '--'}</strong></div>
          ${data.missingConfig?.length ? `<div class="wide"><label>缺失环境变量</label><strong class="down">${esc(data.missingConfig.join(', '))}</strong></div>` : ''}
        </div>
        ${wechatState.previewText ? `
          <div class="adm-preview-box">
            <div class="adm-preview-head"><strong>${esc(wechatState.previewTitle)}</strong><button class="sm-action-btn" type="button" onclick="AdminWechat.clearPreview()">关闭预览</button></div>
            <pre>${esc(wechatState.previewText)}</pre>
          </div>
        ` : ''}
      `;
    }

    if (jobsEl) {
      const jobs = Array.isArray(data.recentJobs) ? data.recentJobs : [];
      if (!jobs.length) {
        jobsEl.innerHTML = '<div class="recap-empty-inline">暂无历史推送任务记录</div>';
      } else {
        jobsEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>ID</th><th>类型</th><th>统计周期</th><th>新股/新债数</th><th>状态</th><th>目标/成功/失败</th><th>完成时间</th><th>操作</th></tr></thead><tbody>${jobs.map(j => {
          const active = wechatState.selectedJobId === j.id ? ' class="sm-row-active"' : '';
          const stateCls = j.status === 'completed' ? 'up' : j.status === 'failed' ? 'down' : '';
          return `<tr${active}>
            <td>#${esc(j.id)}</td>
            <td>${j.kind === 'daily' ? '每日提醒' : '每周汇总'}</td>
            <td>${esc(j.periodStart)}${j.periodEnd && j.periodEnd !== j.periodStart ? ` ~ ${esc(j.periodEnd)}` : ''}</td>
            <td>${j.ipoCount}</td>
            <td class="${stateCls}"><strong>${esc(j.status)}</strong></td>
            <td>${j.recipientCount} / <span class="up">${j.successCount}</span> / <span class="${j.failureCount ? 'down' : ''}">${j.failureCount}</span></td>
            <td>${esc(fmtTime(j.finishedAt || j.createdAt))}</td>
            <td><button class="sm-action-btn" type="button" onclick="AdminWechat.inspectJob('${esc(j.id)}')">投递明细</button></td>
          </tr>`;
        }).join('')}</tbody></table>`;
      }
    }

    if (detailEl) {
      if (!wechatState.jobDetail) {
        detailEl.innerHTML = '<div class="recap-empty-inline">点击上方任意推送任务的「投递明细」，查看推送全文与脱敏用户发送结果。</div>';
      } else {
        const { job, deliveries } = wechatState.jobDetail;
        detailEl.innerHTML = `
          <div class="sm-seats-head">
            <strong>任务 #${esc(job.id)}（${esc(job.jobKey)}）投递详情</strong>
            <small>状态：${esc(job.status)} · 成功 ${job.successCount} / 失败 ${job.failureCount}${job.lastError ? ` · 错误：${esc(job.lastError)}` : ''}</small>
          </div>
          <div class="adm-job-split">
            <div class="adm-preview-box" style="margin:0"><div class="adm-preview-head"><strong>推送消息内容</strong></div><pre>${esc(job.content)}</pre></div>
            <div class="limit-pool-table-wrap" style="max-height:280px">
              <table class="limit-pool-table" style="min-width:460px"><thead><tr><th>用户(脱敏)</th><th>状态</th><th>尝试</th><th>响应说明</th><th>发送时间</th></tr></thead>
              <tbody>${(deliveries || []).length ? deliveries.map(d => `<tr>
                <td><code>${esc(d.maskedOpenid)}</code></td>
                <td class="${d.status === 'sent' ? 'up' : d.status === 'failed' ? 'down' : ''}">${esc(d.status)}</td>
                <td>${d.attemptCount}</td>
                <td>${esc(d.errcode ? `[${d.errcode}] ${d.errmsg || ''}` : (d.errmsg || 'ok'))}</td>
                <td>${esc(fmtTime(d.sentAt || d.updatedAt))}</td>
              </tr>`).join('') : '<tr><td colspan="5" class="recap-empty-inline">无逐用户投递记录</td></tr>'}</tbody></table>
            </div>
          </div>
        `;
      }
    }
  }

  async function loadWechat(force = false) {
    if (!window.currentUser?.isAdmin) return;
    const statusEl = document.getElementById('admin-wechat-status');
    if (statusEl) statusEl.textContent = '正在加载公众号配置与推送记录…';
    try {
      wechatState.overview = await adminApi('/api/admin/wechat/overview', { method: 'GET', headers: {} });
      if (statusEl) statusEl.textContent = `已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      renderWechat();
      if (force) toast('公众号状态已刷新');
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || '加载失败';
    }
  }

  async function inspectJob(jobId) {
    wechatState.selectedJobId = String(jobId);
    renderWechat();
    try {
      wechatState.jobDetail = await adminApi(`/api/admin/wechat/jobs?id=${encodeURIComponent(jobId)}`, { method: 'GET', headers: {} });
      renderWechat();
    } catch (error) {
      toast(error.message || '读取任务详情失败', true);
    }
  }

  async function triggerPush(kind, { dryRun = false, retryFailed = false } = {}) {
    if (wechatState.busy) return;
    if (!dryRun && !window.confirm(`确定立即向所有已开启提醒的关注者执行「${kind === 'daily' ? '今日打新提醒' : '本周打新汇总'}」${retryFailed ? '（含失败重推）' : ''}吗？`)) {
      return;
    }
    wechatState.busy = true;
    try {
      const res = await adminApi('/api/admin/wechat/push', {
        method: 'POST',
        body: JSON.stringify({ kind, dryRun, retryFailed }),
      });
      if (dryRun) {
        wechatState.previewTitle = `${kind === 'daily' ? '今日打新' : '本周汇总'}预览（共 ${res.ipoCount ?? 0} 只标的，未实际发送）`;
        wechatState.previewText = res.content || '（无内容）';
        renderWechat();
        toast('已生成推送预览文案');
      } else {
        toast(res.accepted ? `推送完成：成功 ${res.success ?? 0}，失败 ${res.failure ?? 0}` : (res.reason || (res.alreadyCompleted ? '该周期任务已完成推送' : '未触发推送')));
        await loadWechat();
      }
    } catch (error) {
      toast(error.message || '操作失败', true);
    } finally {
      wechatState.busy = false;
    }
  }

  async function syncMenu() {
    if (!window.confirm('确定将默认菜单结构同步到微信公众号后台吗？')) return;
    try {
      await adminApi('/api/admin/wechat/menu/sync', { method: 'POST', body: '{}' });
      toast('微信公众号自定义菜单同步成功');
    } catch (error) {
      toast(error.message || '菜单同步失败', true);
    }
  }

  async function syncSubscribers() {
    try {
      const res = await adminApi('/api/admin/wechat/subscribers/sync', { method: 'POST', body: '{}' });
      toast(`已从微信后台同步 ${res.synchronized ?? 0} 位关注者`);
      await loadWechat();
    } catch (error) {
      toast(error.message || '同步关注者失败', true);
    }
  }

  function clearPreview() {
    wechatState.previewText = '';
    wechatState.previewTitle = '';
    renderWechat();
  }

  // =========================================================================
  // 10. Admin System Health & Upstream Telemetry
  // =========================================================================
  const healthState = {
    payload: null,
    probeResults: {},
    probingTarget: '',
  };

  function statusPill(status) {
    if (status === 'healthy') return '<span class="admin-user-state granted">正常</span>';
    if (status === 'degraded') return '<span class="admin-user-state admin">降级/偶发失败</span>';
    if (status === 'down' || status === 'error') return '<span class="sm-tag sm-tag-warn">异常</span>';
    return '<span class="admin-user-state">待命（尚无请求）</span>';
  }

  function renderHealth() {
    const data = healthState.payload;
    if (!data) return;
    const rt = data.runtime || {};
    const sv = data.services || {};
    const up = data.upstream || {};

    const summaryEl = document.getElementById('admin-health-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="metric-card"><div class="metric-label">进程运行时长</div><div class="metric-value" style="font-size:20px">${esc(fmtDuration(rt.uptimeSeconds))}</div><div class="metric-note">Node ${esc(rt.nodeVersion || '--')} ·上海日 ${esc(rt.shanghaiDate || '--')}</div></div>
        <div class="metric-card"><div class="metric-label">内存占用 (RSS / Heap)</div><div class="metric-value" style="font-size:20px">${esc(fmtBytes(rt.rssBytes))}</div><div class="metric-note">JS 堆 ${esc(fmtBytes(rt.heapUsedBytes))} / ${esc(fmtBytes(rt.heapTotalBytes))}</div></div>
        <div class="metric-card"><div class="metric-label">聊天室在线连接</div><div class="metric-value">${sv.chat?.onlineUsers ?? 0} 人</div><div class="metric-note">活跃 SSE 流 ${sv.chat?.totalConnections ?? 0} 个</div></div>
        <div class="metric-card"><div class="metric-label">子系统就绪状态</div><div class="metric-value" style="font-size:15px;line-height:1.5">账号:${sv.account?.ready ? '✓' : '—'} · 微信:${sv.wechat?.ready ? '✓' : '—'} · AI:${sv.ai?.enabled ? '✓' : '—'}</div><div class="metric-note">驱动：${esc(sv.account?.driver || 'disabled')}</div></div>
      `;
    }

    const probesEl = document.getElementById('admin-health-probes');
    if (probesEl) {
      const targets = [
        { key: 'tencent', label: '腾讯实时行情' },
        { key: 'eastmoney', label: '东方财富 push2' },
        { key: 'sina', label: '新浪财经接口' },
        { key: 'ai_agent', label: 'Python AI Agent' },
      ];
      probesEl.innerHTML = targets.map(t => {
        const res = healthState.probeResults[t.key];
        const running = healthState.probingTarget === t.key;
        return `
          <div class="adm-probe-card">
            <div class="adm-probe-head">
              <strong>${esc(t.label)}</strong>
              <button class="sm-action-btn" type="button" ${running ? 'disabled' : ''} onclick="AdminSystemHealth.probe('${t.key}')">${running ? '探测中…' : '立即自检'}</button>
            </div>
            <div class="adm-probe-meta">
              ${res ? `${res.ok ? '<span class="up">● 连通</span>' : '<span class="down">● 失败</span>'} · ${res.latencyMs}ms · ${esc(res.message)}` : '点击「立即自检」主动测试端到端响应延迟'}
            </div>
          </div>
        `;
      }).join('');
    }

    const upstreamEl = document.getElementById('admin-health-upstreams');
    if (upstreamEl) {
      const providers = Array.isArray(up.providers) ? up.providers : [];
      upstreamEl.innerHTML = `<table class="limit-pool-table"><thead><tr><th>上游数据源</th><th>承担职责</th><th>状态</th><th>累计请求</th><th>成功率</th><th>平均/最近耗时</th><th>最近成功</th><th>最近错误摘要</th></tr></thead><tbody>${providers.map(p => `
        <tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td style="color:var(--ui-text-muted);font-size:11.5px">${esc(p.role)}</td>
          <td>${statusPill(p.status)}</td>
          <td>${p.totalRequests}</td>
          <td class="${p.successRate != null && p.successRate < 90 ? 'down' : ''}">${p.successRate != null ? `${p.successRate}%` : '--'}</td>
          <td>${p.avgLatencyMs != null ? `${p.avgLatencyMs}ms / ${p.lastLatencyMs}ms` : '--'}</td>
          <td>${esc(fmtTime(p.lastSuccessAt))}</td>
          <td class="sm-reason-cell" title="${esc(p.lastError || '')}">${esc(p.lastError || '--')}</td>
        </tr>
      `).join('')}</tbody></table>`;
    }

    const cachesEl = document.getElementById('admin-health-caches');
    if (cachesEl) {
      const caches = Array.isArray(data.caches) ? data.caches : [];
      cachesEl.innerHTML = caches.map(c => `
        <div class="adm-cache-card">
          <div>
            <strong>${esc(c.label)}</strong>
            <small>当前缓存键数：<b>${c.entries}</b></small>
          </div>
          <button class="sm-action-btn" type="button" onclick="AdminSystemHealth.clearCache('${esc(c.key)}')">清空</button>
        </div>
      `).join('');
    }
  }

  async function loadHealth(force = false) {
    if (!window.currentUser?.isAdmin) return;
    const statusEl = document.getElementById('admin-health-status');
    if (statusEl) statusEl.textContent = '正在采集系统健康指标…';
    try {
      healthState.payload = await adminApi('/api/admin/system/health', { method: 'GET', headers: {} });
      if (statusEl) statusEl.textContent = `最近采样：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      renderHealth();
      if (force) toast('系统健康指标已刷新');
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message || '加载失败';
    }
  }

  async function probe(target) {
    if (healthState.probingTarget) return;
    healthState.probingTarget = target;
    renderHealth();
    try {
      const res = await adminApi('/api/admin/system/probe', {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
      healthState.probeResults[target] = res;
      await loadHealth(false);
    } catch (error) {
      healthState.probeResults[target] = { ok: false, latencyMs: 0, message: error.message || '探测异常' };
    } finally {
      healthState.probingTarget = '';
      renderHealth();
    }
  }

  async function clearCache(target = 'all') {
    if (target === 'all' && !window.confirm('确定清空全部服务端内存行情缓存吗？清空后下次访问将重新向上游拉取。')) return;
    try {
      const res = await adminApi('/api/admin/system/cache-clear', {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
      if (healthState.payload) healthState.payload.caches = res.caches || [];
      renderHealth();
      toast(target === 'all' ? '已清空全部内存行情缓存' : '已清空指定模块缓存');
    } catch (error) {
      toast(error.message || '清理缓存失败', true);
    }
  }

  window.AdminWechat = {
    load: loadWechat,
    inspectJob,
    triggerPush,
    syncMenu,
    syncSubscribers,
    clearPreview,
  };

  window.AdminSystemHealth = {
    load: loadHealth,
    probe,
    clearCache,
  };
})();
