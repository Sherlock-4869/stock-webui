(function initializeNoteReader(global) {
  'use strict';

  function setStatus(message, error = false) {
    const element = document.getElementById('note-reader-status');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('error', error);
  }

  function validNoteId() {
    const id = new URLSearchParams(location.search).get('id') || '';
    return /^[1-9]\d*$/.test(id) ? id : '';
  }

  function downloadName(title) {
    const name = String(title || '').trim().replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);
    return `${name || '个人笔记'}.md`;
  }

  function downloadNote(note) {
    const blob = new Blob([String(note.content || '')], { type:'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName(note.title);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function buildToc(article) {
    const toc = document.getElementById('note-reader-toc');
    if (!toc) return;
    toc.replaceChildren();
    const headings = [...article.querySelectorAll('h2,h3')];
    if (!headings.length) {
      const empty = document.createElement('span');
      empty.className = 'reader-empty';
      empty.textContent = '当前笔记没有二、三级标题';
      toc.appendChild(empty);
      return;
    }
    headings.forEach(heading => {
      const link = document.createElement('a');
      link.className = `level-${heading.tagName.slice(1)}`;
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent || '未命名标题';
      toc.appendChild(link);
    });
  }

  async function load() {
    const noteId = validNoteId();
    const article = document.getElementById('note-reader-document');
    if (!article || !noteId) {
      setStatus('笔记链接无效', true);
      return;
    }
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, { headers:{ Accept:'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.note) throw new Error(payload.error || `加载失败（${response.status}）`);
      const note = payload.note;
      document.title = `${note.title || '个人笔记'} · 深度学习`;
      const title = document.getElementById('note-reader-title');
      title.textContent = note.title || '无标题笔记';
      const content = document.createElement('div');
      content.className = 'reader-markdown';
      content.innerHTML = global.ReferenceReader.renderMarkdown(String(note.content || ''));
      article.replaceChildren(content);
      buildToc(article);
      document.getElementById('note-reader-download').addEventListener('click', () => downloadNote(note));
      setStatus('');
    } catch (error) {
      article.replaceChildren();
      setStatus(`笔记加载失败：${error.message}`, true);
    }
  }

  global.addEventListener('DOMContentLoaded', load, { once:true });
})(window);
