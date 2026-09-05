// Enhance the sanitized DOM, so fenced code and existing external links never
// pass through a global Markdown replacement.
function referenceParts(value) {
  const [file, ...heading] = String(value || '').split('#');
  return { path: file.trim(), heading: heading.join('#') };
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

export function enhanceSourceLinks(target, { basePath = '', fileUrl, onOpen }) {
  const doc = target.ownerDocument;
  function anchor(label, sourcePath, heading = '') {
    const link = doc.createElement('a');
    link.textContent = label;
    link.href = `${fileUrl(sourcePath)}${heading ? `#${encodeURIComponent(heading)}` : ''}`;
    bind(link, sourcePath, heading);
    return link;
  }
  function bind(link, sourcePath, heading) {
    link.target = '';
    link.dataset.knowledgeSource = sourcePath;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      onOpen(sourcePath, heading);
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
      } else if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(href)) {
        source = referenceParts(decodeURIComponent(href));
        source.path = /\.(?:md|txt|pdf|png|jpe?g|gif|webp)$/iu.test(source.path)
          ? localPath(source.path, basePath, true) : '';
      }
    } catch { return; }
    if (source?.path) {
      link.href = `${fileUrl(source.path)}${source.heading ? `#${encodeURIComponent(source.heading)}` : ''}`;
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
  const pattern = /https?:\/\/[^\s<>]+|!?\[\[[^\]\n]+\]\]|〔来源[：:][^〕\n]+〕|[\p{L}\p{N}_][^\s<>"'`()[\]{}，、；;：:!?。]*?\.md(?:#[^\s<>"'`()[\]{}，、；;：:!?。]+)?/giu;
  for (const node of nodes) {
    const text = node.textContent;
    const fragment = doc.createDocumentFragment();
    let end = 0;
    let changed = false;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (/^https?:/iu.test(value)) continue;
      // Do not salvage a safe-looking suffix from an unsafe absolute path.
      if (match.index > 0 && /[\p{L}\p{N}_/\\.:%-]/u.test(text[match.index - 1])) continue;
      const wiki = /^(!?)\[\[([^\]]+)\]\]$/u.exec(value);
      const citation = /^〔来源[：:]([^〕]+)〕$/u.exec(value);
      const [reference, ...alias] = (wiki ? wiki[2] : citation ? citation[1] : value).split('|');
      const source = referenceParts(reference);
      const resolved = localPath(source.path, basePath);
      if (!resolved) continue;
      fragment.append(doc.createTextNode(text.slice(end, match.index)));
      if (wiki?.[1] && /\.(?:png|jpe?g|gif|webp)$/iu.test(resolved)) {
        const img = doc.createElement('img');
        img.src = fileUrl(resolved);
        img.alt = alias.join('|') || source.path;
        fragment.append(img);
      } else {
        fragment.append(anchor(wiki ? alias.join('|') || reference : value, resolved, source.heading));
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
  async function open(reference, heading = '') {
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
          button.addEventListener('click', () => { if (current()) open(candidate, heading); });
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
        if (type.includes('markdown')) {
          render(content, text, sourcePath);
          if (heading) [...content.querySelectorAll('h1,h2,h3,h4,h5,h6')]
            .find((node) => node.textContent.trim() === heading.trim())?.scrollIntoView({ block: 'start' });
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
