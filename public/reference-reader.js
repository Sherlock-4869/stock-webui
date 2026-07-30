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

  async function mount({ article, toc, force = false, footer = '本资料仅供学习参考，不构成任何投资建议' } = {}) {
    const articleElement = typeof article === 'string' ? document.getElementById(article) : article;
    const tocElement = typeof toc === 'string' ? document.getElementById(toc) : toc;
    if (!articleElement || !tocElement) throw new Error('Reference reader container is missing');
    if (!force && articleElement.dataset.loaded === 'true') return { loaded: true, cached: true };
    if (!force && articleElement.dataset.loading === 'true') return { loaded: false, pending: true };

    articleElement.dataset.loading = 'true';
    articleElement.setAttribute('aria-busy', 'true');
    articleElement.innerHTML = '<div class="reference-loading">正在加载参考文档...</div>';
    tocElement.innerHTML = '<span class="reference-loading">加载中...</span>';
    try {
      const suffix = force ? `?t=${Date.now()}` : '';
      const response = await fetch(`/api/reference-document${suffix}`, { headers: { Accept: 'text/markdown' } });
      if (!response.ok) throw new Error(`load failed (${response.status})`);
      const markdown = await response.text();
      articleElement.innerHTML = `${renderMarkdown(markdown)}<div class="doc-footer">${escapeHtml(footer)}</div>`;
      articleElement.dataset.loaded = 'true';
      buildToc(articleElement, tocElement);
      return { loaded: true, cached: false };
    } catch (error) {
      articleElement.dataset.loaded = 'false';
      articleElement.innerHTML = '<div class="reference-error"><div>参考文档加载失败，请稍后重试</div><button class="reference-retry" type="button">重新加载</button></div>';
      tocElement.innerHTML = '<span class="reference-empty">加载失败</span>';
      articleElement.querySelector('.reference-retry').addEventListener('click', () => {
        mount({ article: articleElement, toc: tocElement, force: true, footer });
      });
      return { loaded: false, error };
    } finally {
      articleElement.dataset.loading = 'false';
      articleElement.setAttribute('aria-busy', 'false');
    }
  }

  global.ReferenceReader = Object.freeze({ mount, renderMarkdown });
})(window);
