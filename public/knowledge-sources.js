import { locatePassage, passageHeadings } from './knowledge-passage.js?v=2';
// Enhance the sanitized DOM, so fenced code and existing external links never
// pass through a global Markdown replacement.
function referenceParts(value) {
  const [file, ...heading] = String(value || '').split('#');
  return { path: file.trim(), heading: heading.join('#').trim() };
}

function localPath(value, basePath, relative = false) {
  const raw = String(value || '').trim();
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(raw) || /[\\\u0000-\u001f\u007f]/u.test(raw)) return '';
  const useBase = relative || raw.startsWith('./') || raw.startsWith('../') || !raw.includes('/');
  const parts = useBase ? String(basePath || '').split('/').slice(0, -1) : [];
  for (const part of raw.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else if (part) parts.push(part);
    else return '';
  }
  return parts.join('/');
}

function citationParts(text) {
  const parts = [];
  let start = 0;
  for (const separator of text.matchAll(/(?:[、；;]|\s+\+\s+)(?=[^、；;〕\n]+?\.md\b)/giu)) {
    const previous = text.slice(start, separator.index);
    if (!/\.md(?:\s*#.*)?\s*$/iu.test(previous)) continue;
    parts.push(previous, separator[0]);
    start = separator.index + separator[0].length;
  }
  return [...parts, text.slice(start)];
}

export function enhanceSourceLinks(target, { basePath = '', fileUrl, onOpen, evidence = {}, conversationId = '', knowledgeBaseId = '' }) {
  const doc = target.ownerDocument;
  function anchor(label, sourcePath, heading = '', id = '') {
    const link = doc.createElement('a');
    link.textContent = label;
    bind(link, sourcePath, heading, id);
    return link;
  }
  function bind(link, sourcePath, heading, id = '') {
    const params = new URLSearchParams({ source: sourcePath });
    if (heading) params.set('heading', heading);
    if (id && conversationId) {
      params.set('evidence', id);
      params.set('conversation', conversationId);
    }
    const page = new URL("/knowledge.html", doc.defaultView.location.href);
    if (knowledgeBaseId) page.searchParams.set("knowledgeBaseId", knowledgeBaseId);
    page.hash = params.toString();
    link.href = page.pathname + page.search + page.hash;
    link.target = '';
    link.dataset.knowledgeSource = sourcePath;
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(sourcePath, heading, evidence[id]);
    });
  }
  target.querySelectorAll('a[href]').forEach((link) => {
    if (link.closest('pre') || link.dataset.knowledgeSource) return;
    const href = link.getAttribute('href') || '';
    let source;
    try {
      const url = new URL(href, doc.defaultView.location.href);
      if (url.origin === doc.defaultView.location.origin && url.pathname === '/api/knowledge/file') {
        source = { path: url.searchParams.get('path') || '', heading: decodeURIComponent(url.hash.slice(1)) };
      } else if (href.startsWith('#') && basePath) {
        source = { path: basePath, heading: decodeURIComponent(href.slice(1)) };
      } else if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(href)) {
        source = referenceParts(decodeURIComponent(href));
        source.path = /\.(?:md|txt|pdf|png|jpe?g|gif|webp)$/iu.test(source.path)
          ? localPath(source.path, basePath, true) : '';
      }
    } catch { return; }
    if (source?.path) {
      bind(link, source.path, source.heading);
    }
  });

  // Entire inline code spans can safely contain spaces and punctuation in a
  // filename. Other code expressions retain their literal presentation.
  target.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre, a')) return;
    const source = referenceParts(code.textContent);
    if (!/\.md$/iu.test(source.path)) return;
    const resolved = localPath(source.path, basePath);
    if (!resolved) return;
    const link = anchor('', resolved, source.heading);
    code.replaceWith(link);
    link.append(code);
  });

  const walker = doc.createTreeWalker(target, 4);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('a, pre, code, script, style, textarea, .katex, .katex-display')) nodes.push(node);
  }
  const pattern = /〔依据[：:][a-zA-Z0-9_-]{1,64}〕|https?:\/\/[^\s<>]+|!?\[\[[^\]\n]+\]\]|〔来源[：:][^〕\n]+〕|[\p{L}\p{N}_][^\s<>"'`()[\]{}〔〕，、；;：:!?。]*?\.md(?:#[^\s<>"'`()[\]{}〔〕，、；;：:!?。]+)?/giu;
  for (const node of nodes) {
    const text = node.textContent;
    const fragment = doc.createDocumentFragment();
    let end = 0;
    let changed = false;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (/^https?:/iu.test(value)) continue;
      // Do not salvage a safe-looking suffix from an unsafe absolute path.
      if (!value.startsWith('〔') && !value.includes('[[') && match.index > 0 && /[\p{L}\p{N}_/\\.:%-]/u.test(text[match.index - 1])) continue;
      const marker = /^〔依据[：:]([a-zA-Z0-9_-]+)〕$/u.exec(value);
      if (marker) {
        const id = marker[1];
        const entry = Object.hasOwn(evidence, id) && evidence[id];
        fragment.append(text.slice(end, match.index));
        if (entry?.path && entry.quote) {
          const title = entry.headings?.at(-1);
          const label = [entry.path.split('/').pop(), title, `第${entry.line}行`].filter(Boolean).join(' · ');
          fragment.append(anchor(`〔${label}〕`, entry.path, '', id));
        } else fragment.append('〔原文依据未核验〕');
        end = match.index + value.length;
        changed = true;
        continue;
      }
      const wiki = /^(!?)\[\[([^\]]+)\]\]$/u.exec(value);
      const citation = /^〔来源[：:]([^〕]+)〕$/u.exec(value);
      if (citation) {
        // Historical answers occasionally group several Markdown files in one marker.
        const parts = citationParts(citation[1]);
        const links = doc.createDocumentFragment();
        links.append('〔来源：');
        let linked = false;
        for (const [i, part] of parts.entries()) {
          const source = referenceParts(part);
          const resolved = i % 2 === 0 && localPath(source.path, basePath);
          if (resolved) {
            links.append(anchor(part.trim(), resolved, source.heading));
            linked = true;
          } else links.append(part);
        }
        if (!linked) continue;
        links.append('〕');
        fragment.append(text.slice(end, match.index), links);
      } else {
        const [reference, ...alias] = wiki ? wiki[2].split('|') : [value];
        const source = referenceParts(reference);
        const resolved = wiki && !source.path && source.heading ? basePath : localPath(source.path, basePath);
        if (!resolved) continue;
        fragment.append(text.slice(end, match.index));
        if (wiki?.[1] && /\.(?:png|jpe?g|gif|webp)$/iu.test(resolved)) {
          const img = doc.createElement('img');
          img.src = fileUrl(resolved);
          img.alt = alias.join('|') || source.path;
          fragment.append(img);
        } else {
          fragment.append(anchor(wiki ? alias.join('|') || reference : value, resolved, source.heading));
        }
      }
      end = match.index + value.length;
      changed = true;
    }
    if (changed) {
      fragment.append(doc.createTextNode(text.slice(end)));
      node.replaceWith(fragment);
    }
  }
}

function locateSection(content, pathLabel, sourcePath, heading) {
  const normalize = (text) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const ancestors = [];
  const sections = [...content.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((node) => {
    const level = Number(node.tagName.slice(1));
    ancestors.length = level - 1;
    ancestors[level - 1] = node.textContent.trim();
    return { node, titles: ancestors.filter(Boolean) };
  });
  function jump({ node, titles }) {
    pathLabel.textContent = [sourcePath, ...titles].join(' › ');
    node.classList.add('knowledge-cited-heading');
    node.scrollIntoView({ block: 'start' });
  }
  const key = normalize(heading);
  const matches = sections.filter(({ titles }) =>
    normalize(titles.at(-1)) === key || titles.some((_, i) => normalize(titles.slice(i).join('#')) === key));
  if (matches.length === 1) return jump(matches[0]);
  pathLabel.textContent = matches.length
    ? `${sourcePath} · 有多个“${heading}”章节`
    : `${sourcePath} · 未找到章节“${heading}”，已打开全文`;
  if (!sections.length) return;
  const choices = matches.length ? matches : sections;
  const select = content.ownerDocument.createElement('select');
  select.setAttribute('aria-label', '选择原文章节');
  select.add(new Option('选择原文章节', ''));
  for (const [i, section] of choices.entries()) select.add(new Option(section.titles.join(' › '), String(i)));
  select.addEventListener('change', () => { if (select.value) jump(choices[Number(select.value)]); });
  pathLabel.append(' ', select);
}

export function createSourcePreview({ dialog, title, pathLabel, content, fileUrl, resolveUrl, render, contextKey = () => '' }) {
  let controller = null;
  let objectUrl = '';
  function cancel() {
    controller?.abort();
    controller = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
  dialog.addEventListener('close', () => { if (!dialog.open) cancel(); });
  async function open(reference, heading = '', evidence) {
    if (!reference) return;
    cancel();
    const request = new AbortController();
    controller = request;
    const context = contextKey();
    const current = () => controller === request && !request.signal.aborted && contextKey() === context && dialog.open;
    const fetchOptions = { credentials: 'same-origin', signal: request.signal };
    title.textContent = reference.split('/').pop() || '来源预览';
    pathLabel.textContent = reference;
    content.textContent = '正在读取来源……';
    if (!dialog.open) dialog.showModal();
    try {
      const resolution = await fetch(resolveUrl(reference), fetchOptions);
      const result = await resolution.json();
      if (!current()) return;
      if (resolution.status === 409 && Array.isArray(result.candidates)) {
        content.textContent = '找到多个同名来源，请选择完整路径：';
        const list = content.ownerDocument.createElement('ul');
        for (const candidate of result.candidates) {
          const item = content.ownerDocument.createElement('li');
          const button = content.ownerDocument.createElement('button');
          button.type = 'button';
          button.textContent = candidate;
          button.addEventListener('click', () => { if (current()) open(candidate, heading, evidence); });
          item.append(button);
          list.append(item);
        }
        content.append(list);
        return;
      }
      if (!resolution.ok || !result.path) throw new Error(result.message || '无法定位来源文件。');
      const sourcePath = result.path;
      title.textContent = sourcePath.split('/').pop();
      pathLabel.textContent = sourcePath;
      const response = await fetch(fileUrl(sourcePath), fetchOptions);
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.message || '无法读取来源文件。');
      }
      const type = response.headers.get('content-type') || '';
      if (type.startsWith('text/') || type.includes('json')) {
        const text = await response.text();
        if (!current()) return;
        content.replaceChildren();
        if (evidence) {
          const source = text.replace(/\r\n/g, '\n');
          const match = locatePassage(source, evidence.quote, evidence.line);
          if (match) {
            const headings = type.includes('markdown') ? passageHeadings(source, match.line) : [];
            pathLabel.textContent = [sourcePath, ...headings, `第${match.line}行`].join(' › ');
            if (type.includes('markdown')) {
              render(content, text, sourcePath);
              const blocks = [...content.querySelectorAll('p, li, td, pre, blockquote')]
                .filter((node) => node.textContent.includes(evidence.quote));
              // Nested list items and blockquotes can contain the very same paragraph.
              const inner = blocks.filter((node) => !blocks.some((other) => node !== other && node.contains(other)));
              if (inner.length === 1 && source.indexOf(evidence.quote) === source.lastIndexOf(evidence.quote)) {
                const it = content.ownerDocument.createTreeWalker(inner[0], NodeFilter.SHOW_TEXT);
                while (it.nextNode()) {
                  const start = it.currentNode.data.indexOf(evidence.quote);
                  if (start < 0) continue;
                  const excerpt = it.currentNode.splitText(start);
                  excerpt.splitText(evidence.quote.length);
                  const mark = content.ownerDocument.createElement('mark');
                  mark.className = 'knowledge-cited-passage';
                  excerpt.replaceWith(mark);
                  mark.append(excerpt);
                  mark.scrollIntoView({ block: 'center' });
                  return;
                }
              }
            }
            const pre = content.ownerDocument.createElement('pre');
            pre.className = 'knowledge-source-raw';
            const mark = content.ownerDocument.createElement('mark');
            mark.className = 'knowledge-cited-passage';
            mark.textContent = evidence.quote;
            pre.append(source.slice(0, match.index), mark, source.slice(match.index + evidence.quote.length));
            content.replaceChildren(pre);
            mark.scrollIntoView({ block: 'center' });
            return;
          }
          pathLabel.textContent = `${sourcePath} · 原文可能已修改或引文重复，无法唯一定位。已打开当前全文。`;
        }
        if (type.includes('markdown')) {
          render(content, text, sourcePath);
          content.scrollTop = 0;
          if (heading) locateSection(content, pathLabel, sourcePath, heading);
        } else {
          const pre = content.ownerDocument.createElement('pre');
          pre.textContent = text;
          content.append(pre);
        }
      } else {
        const blob = await response.blob();
        if (!current()) return;
        objectUrl = URL.createObjectURL(blob);
        content.replaceChildren();
        const node = content.ownerDocument.createElement(type.startsWith('image/') ? 'img' : type === 'application/pdf' ? 'iframe' : 'a');
        if (node.tagName === 'A') {
          node.href = objectUrl;
          node.download = sourcePath.split('/').pop();
          node.textContent = '下载这个文件';
        } else {
          node.src = objectUrl;
          node.title = sourcePath;
          if (node.tagName === 'IMG') node.alt = sourcePath;
        }
        content.append(node);
      }
    } catch (error) {
      if (current()) content.textContent = error.message;
    }
  }
  return { open, cancel };
}
