(function initializeReferenceReader(global) {
  'use strict';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function inlineMarkdown(value) {
    const code = [];
    let html = escapeHtml(value).replace(/`([^`]+)`/g, (_, text) => `@@CODE${code.push(text) - 1}@@`);
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return html.replace(/@@CODE(\d+)@@/g, (_, index) => `<code>${code[Number(index)]}</code>`);
  }

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function headingSlug(text, index, slugs) {
    const base = text
      .replace(/\*\*|`|[^\w\u4e00-\u9fff-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || `section-${index}`;
    const count = slugs.get(base) || 0;
    slugs.set(base, count + 1);
    return `reference-${count ? `${base}-${count + 1}` : base}`;
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r/g, '').split('\n');
    const output = [];
    const slugs = new Map();
    let index = 0;
    let headingIndex = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (/^```/.test(line.trim())) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        const id = headingSlug(heading[2], ++headingIndex, slugs);
        output.push(`<h${level} id="${id}">${inlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) { output.push('<hr>'); index += 1; continue; }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
        output.push(`<blockquote><p>${inlineMarkdown(quote.join(' '))}</p></blockquote>`);
        continue;
      }
      if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
        const headers = tableCells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
        output.push(`<div class="table-scroll"><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const unordered = line.match(/^\s*-\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (unordered || ordered) {
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*-\s+(.+)$/;
        while (index < lines.length) {
          const match = lines[index].match(pattern);
          if (!match) break;
          items.push(match[1]);
          index += 1;
        }
        output.push(`<${tag}>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</${tag}>`);
        continue;
      }
      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length
        && lines[index].trim()
        && !/^(#{1,4})\s+|^```|^>\s?|^\s*---+\s*$|^\s*-\s+|^\s*\d+\.\s+/.test(lines[index])
        && !(index + 1 < lines.length && lines[index].includes('|') && isTableDivider(lines[index + 1]))) {
        paragraph.push(lines[index++].trim());
      }
      output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    }
    return output.join('');
  }

  function buildToc(article, toc) {
    const headings = [...article.querySelectorAll('h2,h3')];
    toc.innerHTML = headings.length
      ? headings.map(heading => `<a class="level-${heading.tagName.slice(1)}" href="#${heading.id}">${escapeHtml(heading.textContent)}</a>`).join('')
      : '<span class="reference-empty">文档暂无标题</span>';
  }

  async function fetchDocumentList(force = false) {
    const suffix = force ? `?t=${Date.now()}` : '';
    const response = await fetch(`/api/reference-documents${suffix}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`list failed (${response.status})`);
    const payload = await response.json();
    const documents = Array.isArray(payload.documents) ? payload.documents.filter(item => item && item.id && item.title) : [];
    if (!documents.length) throw new Error('reference document list is empty');
    return documents;
  }

  function selectedDocumentId(selector, documents) {
    const queryId = new URLSearchParams(location.search).get('id');
    const selected = queryId || selector?.value;
    return documents.some(item => String(item.id) === String(selected)) ? String(selected) : String(documents[0].id);
  }

  function renderDocumentSelector(selector, documents, selectedId) {
    if (!selector) return;
    selector.replaceChildren();
    documents.forEach(documentInfo => {
      const option = document.createElement('option');
      option.value = String(documentInfo.id);
      option.textContent = documentInfo.title;
      if (documentInfo.description) option.title = documentInfo.description;
      selector.appendChild(option);
    });
    selector.value = selectedId;
    // Keep the picker interactive even for a single document. If another
    // document is added while this page is open, the next page activation can
    // refresh the options without leaving a stale disabled control behind.
    selector.disabled = false;
  }

  function renderDocumentList(list, documents, selectedId, onSelect) {
    if (!list) return;
    list.replaceChildren();
    documents.forEach(documentInfo => {
      const link = document.createElement('a');
      link.href = `?page=reference&id=${encodeURIComponent(documentInfo.id)}`;
      link.dataset.documentId = String(documentInfo.id);
      link.className = String(documentInfo.id) === String(selectedId) ? 'active' : '';
      link.innerHTML = `${escapeHtml(documentInfo.title)}${documentInfo.description ? `<small>${escapeHtml(documentInfo.description)}</small>` : ''}`;
      link.addEventListener('click', event => {
        event.preventDefault();
        if (typeof onSelect === 'function') onSelect(String(documentInfo.id));
      });
      list.appendChild(link);
    });
  }

  function updateReferenceLinks({ selectedId, download, standalone }) {
    if (download) download.href = `/download/reference-document?id=${encodeURIComponent(selectedId)}`;
    if (standalone) standalone.href = `/reference.html?id=${encodeURIComponent(selectedId)}`;
  }

  async function mount({ article, toc, selector, documentList, download, standalone, force = false, footer = '本资料仅供学习参考，不构成任何投资建议' } = {}) {
    const articleElement = typeof article === 'string' ? document.getElementById(article) : article;
    const tocElement = typeof toc === 'string' ? document.getElementById(toc) : toc;
    const selectorElement = typeof selector === 'string' ? document.getElementById(selector) : selector;
    const documentListElement = typeof documentList === 'string' ? document.getElementById(documentList) : documentList;
    const downloadElement = typeof download === 'string' ? document.getElementById(download) : download;
    const standaloneElement = typeof standalone === 'string' ? document.getElementById(standalone) : standalone;
    if (!articleElement || !tocElement) throw new Error('Reference reader container is missing');
    if (!force && articleElement.dataset.loading === 'true') return { loaded: false, pending: true };

    articleElement.dataset.loading = 'true';
    articleElement.setAttribute('aria-busy', 'true');
    articleElement.innerHTML = '<div class="reference-loading">正在加载参考文档...</div>';
    tocElement.innerHTML = '<span class="reference-loading">加载中...</span>';
    try {
      let documents;
      let usedFallback = false;
      try {
        documents = await fetchDocumentList(force);
      } catch (listError) {
        if (force) throw listError;
        documents = [{ id:'static', title:'参考文档', description:'' }];
        usedFallback = true;
      }
      const selectedId = selectedDocumentId(selectorElement, documents);
      renderDocumentSelector(selectorElement, documents, selectedId);
      renderDocumentList(documentListElement, documents, selectedId, id => {
        if (selectorElement) selectorElement.value = id;
        mount({ article:articleElement, toc:tocElement, selector:selectorElement, documentList:documentListElement, download:downloadElement, standalone:standaloneElement, force:true, footer });
      });
      updateReferenceLinks({ selectedId, download:downloadElement, standalone:standaloneElement });
      const suffix = `?id=${encodeURIComponent(selectedId)}${force ? `&t=${Date.now()}` : ''}`;
      const response = await fetch(`/api/reference-document${suffix}`, { headers: { Accept: 'text/markdown' } });
      if (!response.ok) throw new Error(`load failed (${response.status})`);
      const markdown = await response.text();
      articleElement.innerHTML = `${renderMarkdown(markdown)}<div class="doc-footer">${escapeHtml(footer)}</div>`;
      articleElement.dataset.loaded = 'true';
      articleElement.dataset.referenceFallback = usedFallback ? 'true' : 'false';
      articleElement.dataset.documentId = selectedId;
      buildToc(articleElement, tocElement);
      if (selectorElement && selectorElement.dataset.referenceBound !== 'true') {
        selectorElement.dataset.referenceBound = 'true';
        selectorElement.addEventListener('change', () => mount({ article:articleElement, toc:tocElement, selector:selectorElement, documentList:documentListElement, download:downloadElement, standalone:standaloneElement, force:true, footer }));
      }
      return { loaded: true, cached: false, documentId:selectedId, documents };
    } catch (error) {
      articleElement.dataset.loaded = 'false';
      articleElement.innerHTML = '<div class="reference-error"><div>参考文档加载失败，请稍后重试</div><button class="reference-retry" type="button">重新加载</button></div>';
      tocElement.innerHTML = '<span class="reference-empty">加载失败</span>';
      articleElement.querySelector('.reference-retry').addEventListener('click', () => {
        mount({ article:articleElement, toc:tocElement, selector:selectorElement, documentList:documentListElement, download:downloadElement, standalone:standaloneElement, force:true, footer });
      });
      return { loaded: false, error };
    } finally {
      articleElement.dataset.loading = 'false';
      articleElement.setAttribute('aria-busy', 'false');
    }
  }

  global.ReferenceReader = Object.freeze({ mount, renderMarkdown });
})(window);
