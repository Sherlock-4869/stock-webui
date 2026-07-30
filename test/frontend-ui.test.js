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
  assert.match(html, /id="note-files-tab"[^>]*role="tab"[^>]*>文件列表<\/button>/);
  assert.match(html, /id="note-headings-tab"[^>]*role="tab"[^>]*>标题导航<\/button>/);
  assert.match(html, /id="note-toc-list"[^>]*aria-label="当前笔记标题导航"/);
  assert.match(html, /id="note-folder-list"/);
  assert.match(html, /onclick="createNoteFolder\(\)"/);
  assert.match(html, /id="note-folder-select"[^>]*onchange="moveCurrentNoteToFolder\(this\.value\)"/);
  assert.match(html, /async function createNoteFolder\(\)/);
  assert.match(html, /async function renameNoteFolder\(folderId\)/);
  assert.match(html, /async function deleteNoteFolder\(folderId\)/);
  assert.match(html, /笔记会移到“未分类”，不会被删除/);
  assert.doesNotMatch(html, /note-toc-popover|toggleNoteToc/);
});

test('reference documentation is immediately to the left of theme controls', () => {
  const navStart = html.indexOf('<div class="app-nav-inner">');
  const navEnd = html.indexOf('</nav>', navStart);
  const nav = html.slice(navStart, navEnd);
  const referenceIndex = nav.indexOf('data-page="reference"');
  assert.ok(referenceIndex > nav.indexOf('id="chat-entry-btn"'));
  assert.ok(referenceIndex < nav.indexOf('class="theme-setting"'));
  assert.match(nav, /data-page="reference"[^>]*>📚 参考文档<\/button>\s*<label class="theme-setting"/);
  assert.match(html, /<section class="app-page" id="page-reference">/);
  assert.match(html, /href="\/reference\.html" target="_blank" rel="noopener noreferrer"/);
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
  assert.match(html, /const APP_PAGES = \['market','ipo','alerts','notes','reference'\]/);
  assert.match(html, /history\.pushState\(\{ page \}, '', url\)/);
  assert.match(html, /addEventListener\('popstate'/);
  assert.match(html, /aria-current/);
});

test('chat UI starts each entry empty and bounds temporary rendered content', () => {
  assert.match(html, /const CHAT_MAX_RENDERED_MESSAGES = 200;/);
  assert.match(html, /const CHAT_MAX_RENDERED_IMAGES = 20;/);
  assert.match(html, /function clearChatSessionView\(\)[\s\S]*?messages\.replaceChildren\(\)/);
  assert.match(html, /while \(container\.childElementCount > CHAT_MAX_RENDERED_MESSAGES\)/);
  assert.match(html, /while \(container\.querySelectorAll\('\.chat-msg-image'\)\.length > CHAT_MAX_RENDERED_IMAGES\)/);

  const sessionStart = html.indexOf('async function loadChatSession');
  const sessionEnd = html.indexOf('function updateChatOnline', sessionStart);
  assert.ok(sessionStart >= 0 && sessionEnd > sessionStart);
  assert.doesNotMatch(html.slice(sessionStart, sessionEnd), /appendChatMessage/);
});

test('chat UI exposes emoji and validated image controls', () => {
  assert.match(html, /id="chat-emoji-btn"/);
  assert.match(html, /id="chat-emoji-panel"/);
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

test('fund flow failures expose an in-place retry action', () => {
  assert.match(html, /className = 'chart-retry-btn'/);
  assert.match(html, /retry\.addEventListener\('click', \(\) => loadChart\('fundFlow'\)\)/);
  assert.match(html, /主力资金加载失败，请稍后重试/);
});
