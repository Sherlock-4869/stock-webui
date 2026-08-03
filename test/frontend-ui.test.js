'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const referenceHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'reference.html'), 'utf8');
const referenceReaderScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'reference-reader.js'), 'utf8');

function markdownFunctions() {
  const start = html.indexOf('function safeMarkdownUrl');
  const end = html.indexOf('function updateNotePreview', start);
  assert.ok(start >= 0 && end > start, 'Markdown functions must exist in index.html');
  const context = {
    escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    },
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('Markdown heading navigation ignores fenced code and matches preview anchors', () => {
  const { extractMarkdownHeadings, renderMarkdown } = markdownFunctions();
  const markdown = [
    '# 总览',
    '```md',
    '# 代码里的伪标题',
    '```',
    '## 交易计划',
    '### 风险提示',
  ].join('\n');

  const headings = JSON.parse(JSON.stringify(extractMarkdownHeadings(markdown)));
  assert.deepEqual(headings, [
    { level: 1, text: '总览', id: 'note-heading-0' },
    { level: 2, text: '交易计划', id: 'note-heading-1' },
    { level: 3, text: '风险提示', id: 'note-heading-2' },
  ]);

  const preview = renderMarkdown(markdown);
  assert.match(preview, /<h1 id="note-heading-0">总览<\/h1>/);
  assert.match(preview, /<h2 id="note-heading-1">交易计划<\/h2>/);
  assert.match(preview, /<h3 id="note-heading-2">风险提示<\/h3>/);
  assert.match(preview, /<pre><code class="lang-md"># 代码里的伪标题/);
  assert.doesNotMatch(preview, /id="note-heading-3"/);
});

test('notes keep file and heading navigation in fixed sidebar tabs with folder controls', () => {
  assert.match(html, /\.note-sidebar\{position:sticky;top:66px/);
  assert.match(html, /\.note-toolbar\{position:sticky;z-index:25;top:66px/);
  assert.match(html, /id="note-files-tab"[^>]*role="tab"[^>]*>文件列表<\/button>/);
  assert.match(html, /id="note-headings-tab"[^>]*role="tab"[^>]*>标题导航<\/button>/);
  assert.match(html, /id="note-toc-list"[^>]*aria-label="当前笔记标题导航"/);
  assert.match(html, /id="note-folder-list"/);
  assert.match(html, /onclick="createNoteFolder\(\)"/);
  assert.match(html, /id="note-create-folder-select"[^>]*onchange="setNoteCreateFolder\(this\.value\)"/);
  assert.match(html, />新建\/导入到<select/);
  assert.match(html, /id="note-folder-select"[^>]*onchange="moveCurrentNoteToFolder\(this\.value\)"/);
  assert.match(html, />归类到<select/);
  assert.match(html, /async function createNoteFolder\(\)/);
  assert.match(html, /async function renameNoteFolder\(folderId\)/);
  assert.match(html, /async function deleteNoteFolder\(folderId\)/);
  assert.match(html, /笔记会移到“未分类”，不会被删除/);
  assert.doesNotMatch(html, /note-toc-popover|toggleNoteToc/);
});

test('brand navigation returns home without reloading the current application', () => {
  assert.match(html, /class="app-brand"[^>]*href="\/"[^>]*onclick="handleAppBrandClick\(event\)"/);
  const start = html.indexOf('function handleAppBrandClick');
  const end = html.indexOf('async function loadReferenceDocument', start);
  assert.ok(start >= 0 && end > start);
  const pages = [];
  const context = { switchAppPage:page => pages.push(page) };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  let prevented = false;
  context.handleAppBrandClick({ button:0, metaKey:false, ctrlKey:false, shiftKey:false, altKey:false, preventDefault:() => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(pages, ['market']);

  prevented = false;
  context.handleAppBrandClick({ button:0, metaKey:true, ctrlKey:false, shiftKey:false, altKey:false, preventDefault:() => { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(pages, ['market']);
});

test('note heading navigation scrolls the selected preview heading into view', () => {
  const start = html.indexOf('function jumpToNoteHeading');
  const end = html.indexOf('function setNoteView', start);
  assert.ok(start >= 0 && end > start);
  let selector = '';
  let scrollOptions = null;
  const heading = { scrollIntoView:options => { scrollOptions = options; } };
  const preview = { querySelector:value => { selector = value; return heading; } };
  const context = {
    noteViewMode:'split',
    document:{ getElementById:id => id === 'note-preview' ? preview : null },
    setNoteView() {},
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.jumpToNoteHeading('note-heading-2');
  assert.equal(selector, '[id="note-heading-2"]');
  assert.deepEqual(JSON.parse(JSON.stringify(scrollOptions)), { behavior:'smooth', block:'start', inline:'nearest' });
});

test('sidebar groups navigation and supports collapse on desktop plus overlay on mobile', () => {
  const navStart = html.indexOf('<div class="app-nav-inner">');
  const navEnd = html.indexOf('</nav>', navStart);
  const nav = html.slice(navStart, navEnd);
  const referenceIndex = nav.indexOf('data-page="reference"');
  const chatIndex = nav.indexOf('id="chat-entry-btn"');
  const researchGroup = nav.indexOf('id="sidebar-group-research"');
  const aiGroup = nav.indexOf('id="sidebar-group-ai"');
  const communityGroup = nav.indexOf('id="sidebar-group-community"');
  assert.ok(referenceIndex > researchGroup);
  assert.ok(nav.indexOf('id="ai-entry-btn"') > aiGroup);
  assert.ok(nav.indexOf('id="user-ai-models-entry"') > aiGroup);
  assert.ok(chatIndex > communityGroup);
  assert.ok(nav.indexOf('class="sidebar-collapse"') < nav.indexOf('<div class="sidebar-scroll">'));
  assert.match(nav, /id="admin-navigation" hidden/);
  assert.match(nav, /<svg class="app-tab-icon"/);
  assert.doesNotMatch(nav, /<span class="app-tab-icon">/);
  assert.match(html, /class="sidebar-mobile-icon"/);
  assert.match(html, /SIDEBAR_COLLAPSED_STORAGE_KEY/);
  assert.match(html, /function toggleSidebar\(\)/);
  assert.match(html, /body\.sidebar-collapsed/);
  assert.match(html, /@media\(max-width:860px\).*sidebar-open/s);
  assert.match(html, /id="sidebar-mobile-toggle"/);
  assert.match(html, /id="sidebar-hover-label" role="tooltip"/);
  assert.match(html, /item\.addEventListener\('pointerenter', showTooltip\)/);
  assert.match(html, /item\.removeAttribute\('title'\)/);
  assert.match(html, /body\.sidebar-collapsed \.account-trigger\{width:48px;height:48px/);
  assert.match(html, /<section class="app-page" id="page-reference">/);
  assert.match(html, /href="\/reference\.html" target="_blank" rel="noopener noreferrer"/);
});

test('site recommendations open a searchable right-side directory with safe new-tab links', () => {
  assert.match(html, /data-page="sites"[^>]*onclick="switchAppPage\('sites'\)"/);
  assert.match(html, /id="site-recommendations"[^>]*onmouseenter="showSiteRecommendationsPreview\(\)"/);
  assert.match(html, /id="site-recommendation-menu"[^>]*aria-label="推荐站点预览"/);
  assert.match(html, /function renderSiteRecommendationsPreview\(\)/);
  assert.match(html, /function positionSiteRecommendationsPreview\(\)/);
  assert.match(html, /site-recommendation-menu,body\.sidebar-collapsed \.site-recommendation-menu\{position:fixed/);
  assert.match(html, /document\.body\.appendChild\(siteMenu\)/);
  assert.match(html, /body\{overflow-x:clip\}/);
  assert.match(html, /\.app-nav:has\(#site-recommendations:hover\)/);
  assert.match(html, /id="page-sites"/);
  assert.match(html, /id="site-directory-search"[^>]*oninput="filterSiteDirectory\(\)"/);
  assert.match(html, /id="site-directory-grid"/);
  assert.match(html, /\.site-directory-grid\{display:grid/);
  assert.match(html, /apiRequest\('\/api\/site-recommendations'/);
  assert.match(html, /link\.target = '_blank'/);
  assert.match(html, /link\.rel = 'noopener noreferrer'/);

  const start = html.indexOf('function safeRecommendedSiteUrl');
  const end = html.indexOf('function renderSiteDirectory', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.safeRecommendedSiteUrl('https://pro.momoyu.cc'), 'https://pro.momoyu.cc/');
  assert.equal(context.safeRecommendedSiteUrl('javascript:alert(1)'), '');
  assert.equal(context.safeRecommendedSiteUrl('/relative'), '');
});

test('reference reader escapes source HTML and generates stable unique anchors', () => {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(referenceReaderScript, context);

  const rendered = context.ReferenceReader.renderMarkdown([
    '# <script>alert(1)</script>',
    '## 重复标题',
    '## 重复标题',
    '正文 <img src=x onerror=alert(1)>',
  ].join('\n'));

  assert.doesNotMatch(rendered, /<script>|<img/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /id="reference-重复标题"/);
  assert.match(rendered, /id="reference-重复标题-2"/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('standalone and in-page reference views share the same renderer', () => {
  assert.match(html, /<script src="\/reference-reader\.js"><\/script>/);
  assert.match(referenceHtml, /<script src="\/reference-reader\.js"><\/script>/);
  assert.match(referenceHtml, /ReferenceReader\.mount\(\{article:'document',toc:'toc-links'\}\)/);
  assert.doesNotMatch(referenceHtml, /function renderMarkdown/);
});

test('all app pages support direct URL navigation and browser history', () => {
  assert.match(html, /const APP_PAGES = \['market','ipo','alerts','notes','reference','sites','ai','user-ai-models','admin-users','admin-sites','admin-ai'\]/);
  assert.match(html, /document\.title = '深度学习';/);
  assert.doesNotMatch(html, /APP_PAGE_TITLES/);
  assert.match(html, /history\.pushState\(\{ page \}, '', url\)/);
  assert.match(html, /addEventListener\('popstate'/);
  assert.match(html, /aria-current/);
});

test('IPO calendar labels each stock board', () => {
  assert.match(html, /class="ipo-board">\$\{escapeHtml\(ipoBoard\(item\)\)\}/);
  const start = html.indexOf('function ipoBoard');
  const end = html.indexOf('async function fetchIpos', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.ipoBoardForTest = ipoBoard;`, context);
  assert.equal(context.ipoBoardForTest({ code:'301001' }), '创业板');
  assert.equal(context.ipoBoardForTest({ code:'301001', board:'非科创板' }), '创业板');
  assert.equal(context.ipoBoardForTest({ code:'001001', board:'非科创板' }), '深市主板');
  assert.equal(context.ipoBoardForTest({ code:'688001' }), '科创板');
  assert.equal(context.ipoBoardForTest({ code:'603001' }), '沪市主板');
  assert.equal(context.ipoBoardForTest({ code:'001001' }), '深市主板');
  assert.equal(context.ipoBoardForTest({ board:'上海证券交易所主板' }), '沪市主板');
});

test('administrator UI keeps system tools in the sidebar and provides per-user AI access management', () => {
  assert.match(html, /id="page-admin-sites"/);
  assert.match(html, /id="page-admin-users"/);
  assert.match(html, /id="admin-users-list"/);
  assert.match(html, /data-page="admin-users" onclick="switchAppPage\('admin-users'\)"/);
  assert.match(html, /\/api\/admin\/ai\/users/);
  assert.match(html, /function setAdminAiUserPermission\(user, canUse, button\)/);
  assert.match(html, /id="admin-navigation" hidden/);
  assert.match(html, /data-page="admin-sites" onclick="switchAppPage\('admin-sites'\)"/);
  assert.match(html, /apiRequest\('\/api\/admin\/sites'/);
  assert.match(html, /async function saveAdminSite\(event\)/);
  assert.match(html, /async function deleteAdminSite\(siteId\)/);
  assert.match(html, /id="admin-site-admin-only"[^>]*type="checkbox"/);
  assert.match(html, /isAdminOnly:document\.getElementById\('admin-site-admin-only'\)\.checked/);
  assert.match(html, /site\.isAdminOnly === true/);
  assert.match(html, /visibility\.textContent = '仅管理员可见'/);
  assert.match(html, /page === 'admin-users' \|\| page === 'admin-sites' \|\| page === 'admin-ai'/);
  assert.match(html, /if \(user\.isAdmin\).*管理员默认可用/s);
  const accountRenderStart = html.indexOf('function renderAccountArea');
  const accountRenderEnd = html.indexOf('function positionAccountMenu', accountRenderStart);
  assert.ok(accountRenderStart >= 0 && accountRenderEnd > accountRenderStart);
  const accountRender = html.slice(accountRenderStart, accountRenderEnd);
  assert.doesNotMatch(accountRender, /openAdmin(UserManagement|AiManagement|SiteManagement)|openUserAiModels/);
  assert.doesNotMatch(html, /name="isAdmin"|grantAdmin\(/);
});

test('AI stock research UI keeps entry permission-gated and renders chat content as text', () => {
  assert.match(html, /id="ai-entry-btn"[^>]*data-page="ai"[^>]*hidden/);
  assert.match(html, /id="user-ai-models-entry"[^>]*data-page="user-ai-models"/);
  assert.match(html, /id="user-ai-models-entry"[^>]*title="AI模型"/);
  assert.match(html, /id="page-ai"/);
  assert.match(html, /id="page-admin-ai"/);
  assert.match(html, /id="page-user-ai-models"/);
  assert.match(html, /id="ai-model-picker"[^>]*aria-label="本次问股模型"/);
  assert.match(html, /id="ai-model-select"[^>]*onchange="setAiModelSelection\(this\.value\)"/);
  assert.match(html, /id="ai-model-empty"[^>]*>当前没有配置可用模型/);
  assert.doesNotMatch(html, /id="ai-model-catalog-load"|id="ai-provider-model-select"/);
  assert.match(html, /select\.disabled = models\.length < 2 \|\| aiRequestInFlight/);
  assert.match(html, /\.ai-chat-pane\{overflow:hidden\}/);
  assert.match(html, /\.ai-messages\{overflow-y:scroll/);
  assert.match(html, /\.ai-workspace\{height:min\(780px,calc\(100vh - 130px\)\);max-height:none/);
  assert.match(html, /\/api\/ai\/access/);
  assert.match(html, /\/api\/ai\/user-models/);
  assert.match(html, /\/api\/ai\/model-catalog/);
  assert.match(html, /\/api\/ai\/conversations/);
  assert.match(html, /\/api\/admin\/ai\/models/);
  assert.match(html, /\/api\/admin\/ai\/usage/);
  assert.match(html, /\/api\/admin\/ai\/users/);
  assert.match(html, /modelId:selectedAiModelId \|\| undefined, stockContext:stockContextForAi\(\)/);
  assert.match(html, /function createAiMessageElement\(message\)[\s\S]*?content\.textContent = message\.content/);
  assert.match(html, /if \(page === 'ai' && !hasAiMenuAccess\(\)\)/);
  assert.match(html, /if \(page === 'user-ai-models' && !hasAiMenuAccess\(\)\)/);
  assert.doesNotMatch(html, /id="admin-ai-public"|<h3>页面权限<\/h3>/);
  assert.match(html, /function hasAiMenuAccess\(\)/);
  assert.match(html, /function syncRestrictedNavigation\(\)/);
  assert.match(html, /sidebar-group-ai'\)\?\.toggleAttribute\('hidden', !aiVisible\)/);
  assert.match(html, /admin-navigation'\)\?\.toggleAttribute\('hidden', !adminVisible\)/);
  assert.match(html, /\.sidebar-group\[hidden\]\{display:none!important\}/);
  assert.match(html, /if \(page === 'admin-users'\) loadAdminAiUsers\(true\)/);
  assert.match(html, /function testAiModelConnection\(scope\)/);
  assert.match(html, /if \(!aiAccess\.canUse\) \{[\s\S]*?配置模型后即可创建问股会话/);
  assert.match(html, /ai-entry-btn'\)\?\.toggleAttribute\('hidden', !aiVisible\)/);
  assert.match(html, /function setAdminAiModelActive\(id, isActive, button\)/);
  assert.match(html, /function setUserAiModelActive\(id, isActive, button\)/);
  assert.match(html, /toggle\.textContent = model\.isActive \? '停用' : '启用'/);
  assert.match(html, /id="user-ai-model-test"[^>]*onclick="testAiModelConnection\('user'\)"/);
  assert.match(html, /id="admin-ai-model-test"[^>]*onclick="testAiModelConnection\('admin'\)"/);
});

test('fund flow chart clearly marks today-only or stale-cache degradation', () => {
  assert.match(html, /id="chart-data-notice"/);
  assert.match(html, /d\.meta\?\.degraded \|\| d\.meta\?\.stale/);
  assert.match(html, /d\.meta\.message \|\| '历史数据正在后台刷新，当前展示已保存数据'/);
});

test('chat UI loads persisted history upward while bounding rendered content', () => {
  assert.match(html, /const CHAT_MAX_RENDERED_MESSAGES = 500;/);
  assert.match(html, /const CHAT_MAX_RENDERED_IMAGES = 50;/);
  assert.match(html, /const CHAT_INITIAL_HISTORY_PAGE_SIZE = 20;/);
  assert.match(html, /const CHAT_HISTORY_PAGE_SIZE = 50;/);
  assert.match(html, /id="chat-history-loader"[^>]*onclick="loadMoreChatHistory\(\)"/);
  assert.match(html, /getElementById\('chat-messages'\)\.addEventListener\('scroll'/);
  assert.match(html, /scrollTop <= 72\) loadMoreChatHistory\(\)/);
  assert.match(html, /function clearChatSessionView\(\)[\s\S]*?messages\.replaceChildren\(\)/);
  assert.match(html, /while \(container\.childElementCount > CHAT_MAX_RENDERED_MESSAGES\)/);
  assert.match(html, /while \(container\.querySelectorAll\('\.chat-msg-image'\)\.length > CHAT_MAX_RENDERED_IMAGES\)/);
  assert.match(html, /oldestImage\.replaceWith\(placeholder\)/);

  const sessionStart = html.indexOf('async function loadChatSession');
  const sessionEnd = html.indexOf('function updateChatOnline', sessionStart);
  assert.ok(sessionStart >= 0 && sessionEnd > sessionStart);
  const historyFunctions = html.slice(sessionStart, sessionEnd);
  assert.match(historyFunctions, /\/api\/chat\/history\?limit=\$\{CHAT_INITIAL_HISTORY_PAGE_SIZE\}/);
  assert.match(historyFunctions, /chatState\.historySince = data\.historySince \|\| null/);
  assert.match(html, /展开更早聊天记录/);
  assert.match(historyFunctions, /appendChatMessage\(message, false\)/);
  assert.match(historyFunctions, /async function loadMoreChatHistory\(\)/);
  assert.match(historyFunctions, /before:chatState\.historyCursor/);
  assert.match(historyFunctions, /appendChatMessage\(message, false, true\)/);
  assert.match(historyFunctions, /container\.scrollTop = previousTop \+ Math\.max/);
});

test('theme picker supports bright and dark skins while retaining system preference', () => {
  assert.match(html, /const THEME_PREFERENCES = \['light','paper','dark','ocean','forest','violet','system'\]/);
  assert.match(html, /data-theme-skin/);
  assert.match(html, /<option value="paper">暖纸<\/option>/);
  assert.match(html, /<option value="ocean">深海<\/option>/);
  assert.match(html, /<option value="forest">松林<\/option>/);
  assert.match(html, /<option value="violet">暮紫<\/option>/);
  assert.match(html, /Complete the bright surface treatment for chat, account, AI, and administration pages/);
});

test('minimized chat icon supports bounded pointer dragging without accidental restore', () => {
  assert.match(html, /<button class="chat-minimized" id="chat-minimized"[^>]*aria-label="打开聊天室，可拖动位置"/);
  assert.match(html, /\.chat-minimized\{[^}]*touch-action:none/);
  assert.match(html, /initChatMinimizedDrag\(\);/);
  assert.match(html, /addEventListener\('pointerdown'/);
  assert.match(html, /addEventListener\('pointermove'/);
  assert.match(html, /Math\.hypot\(dx, dy\) < 4/);
  assert.match(html, /if \(ignoreNextClick\)[\s\S]*?event\.preventDefault\(\)/);

  const start = html.indexOf('function clampChatMinimizedPosition');
  const end = html.indexOf('function keepChatMinimizedInViewport', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(-10, -20, 52, 52, 320, 480))), { left:0, top:0 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(400, 500, 52, 52, 320, 480))), { left:268, top:428 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.clampChatMinimizedPosition(10, 10, 52, 52, 20, 20))), { left:0, top:0 });
});

test('restored chat window opens beside the dragged minimized icon', () => {
  assert.match(html, /function restoreChatRoom\(\)[\s\S]*?float\.classList\.add\('open'\);\s*positionChatFloatNearMinimizedIcon\(\);\s*icon\.classList\.remove\('visible'\)/);
  const start = html.indexOf('function calculateChatFloatPosition');
  const end = html.indexOf('function positionChatFloatNearMinimizedIcon', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  const rightIcon = { left:740, right:792, top:700, height:52 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateChatFloatPosition(rightIcon, 380, 520, 800, 800))), {
    left:350, top:232, side:'left',
  });
  const leftIcon = { left:8, right:60, top:200, height:52 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateChatFloatPosition(leftIcon, 380, 520, 800, 800))), {
    left:70, top:8, side:'right',
  });
});

test('minimizing a dragged chat places its icon beside the expanded window', () => {
  assert.match(html, /if \(chatState\.floatMoved\) positionChatMinimizedNearFloat\(\)/);
  assert.match(html, /Math\.hypot\(dx, dy\) >= 4\) chatState\.floatMoved = true/);
  const start = html.indexOf('function clampChatMinimizedPosition');
  const end = html.indexOf('function keepChatMinimizedInViewport', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);

  const expanded = { left:200, right:580, top:180, bottom:700 };
  const iconPosition = JSON.parse(JSON.stringify(context.calculateChatMinimizedPositionFromFloat(expanded, 52, 52, 800, 800)));
  assert.deepEqual(iconPosition, { left:590, top:648, side:'right' });
  const restored = JSON.parse(JSON.stringify(context.calculateChatFloatPosition(
    { left:iconPosition.left, right:iconPosition.left + 52, top:iconPosition.top, height:52 },
    380, 520, 800, 800
  )));
  assert.deepEqual(restored, { left:200, top:180, side:'left' });
});

test('chat UI exposes emoji and validated image controls', () => {
  assert.match(html, /id="chat-emoji-btn"/);
  assert.match(html, /id="chat-emoji-panel"/);
  const emojiSource = html.match(/const CHAT_EMOJIS = \[([\s\S]*?)\];/);
  assert.ok(emojiSource, 'chat emoji list should be present');
  const emojiValues = (emojiSource[1].match(/'[^']+'/g) || []).map(value => value.slice(1, -1));
  assert.ok(emojiValues.length >= 190, 'chat should retain common emoji and a broad face selection');
  assert.equal(new Set(emojiValues).size, emojiValues.length, 'chat emoji should not include duplicate variants');
  assert.ok(emojiValues.includes('🫠') && emojiValues.includes('😶‍🌫️') && emojiValues.includes('🫨'));
  assert.equal(emojiValues.some(emoji => Array.from(emoji).some(char => {
    const codePoint = char.codePointAt(0);
    return codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF;
  })), false, 'chat emoji should exclude flags');
  assert.match(html, /chat-emoji-panel\{[^}]*grid-template-columns:repeat\(8,30px\)[^}]*column-gap:3px[^}]*row-gap:2px[^}]*width:298px[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(html, /id="chat-image-btn"[\s\S]*?<svg class="chat-tool-icon"/);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/gif,image\/webp"/);
  assert.match(html, /async function prepareChatImage\(file\)/);
  assert.match(html, /async function sendChatImage\(file\)/);
  assert.match(html, /addEventListener\('paste', handleChatPaste\)/);
  assert.match(html, /function handleChatPaste\(event\)/);
  assert.match(html, /clipboardData\?\.items/);

  const start = html.indexOf('function safeChatImageUrl');
  const end = html.indexOf('function toggleChatEmoji', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`const CHAT_MAX_IMAGE_BYTES = 768 * 1024;\n${html.slice(start, end)}`, context);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(context.safeChatImageUrl(png), png);
  assert.equal(context.safeChatImageUrl('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(context.safeChatImageUrl('javascript:alert(1)'), '');
});

test('account settings provide a validated custom-avatar control', () => {
  assert.match(html, /id="profile-display-name" name="displayName"/);
  assert.match(html, /async function submitProfileChange\(event\)/);
  assert.match(html, /apiRequest\('\/api\/auth\/profile'/);
  assert.match(html, /id="account-avatar-input" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /async function prepareAccountAvatar\(file\)/);
  assert.match(html, /apiRequest\('\/api\/auth\/avatar'/);
  assert.match(html, /removeAccountAvatar\(\)/);
});

test('administrator chat UI can request the server-authorized online user list', () => {
  assert.match(html, /id="chat-online-users"/);
  assert.match(html, /async function loadChatOnlineUsers\(\)/);
  assert.match(html, /apiRequest\('\/api\/chat\/online-users'/);
  assert.match(html, /if \(!currentUser\?\.isAdmin\) return/);
});

test('fund flow failures expose an in-place retry action', () => {
  assert.match(html, /className = 'chart-retry-btn'/);
  assert.match(html, /retry\.addEventListener\('click', \(\) => loadChart\('fundFlow'\)\)/);
  assert.match(html, /主力资金加载失败，请稍后重试/);
});
