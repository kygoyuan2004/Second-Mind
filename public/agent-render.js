(function installVaultMindRenderer(global) {
  function normalizeDisplayMath(source) {
    return String(source || '')
      .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
      .map((part) => {
        if (part.startsWith('```') || part.startsWith('~~~')) return part;
        return part
          .replace(/\$\$([\s\S]*?)\$\$/g, (_match, expression) => (
            `$$${expression.replace(/\s*\r?\n\s*/g, ' ').trim()}$$`
          ))
          .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression) => (
            `\\[${expression.replace(/\s*\r?\n\s*/g, ' ').trim()}\\]`
          ));
      })
      .join('');
  }

  function render(target, source) {
    if (!target) return false;
    if (!global.marked?.parse || !global.DOMPurify) {
      target.textContent = source;
      return false;
    }
    try {
      const parsed = global.marked.parse(normalizeDisplayMath(source), {
        gfm: true,
        breaks: true,
      });
      target.innerHTML = global.DOMPurify.sanitize(parsed, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: [
          'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
          'textarea', 'select',
        ],
        FORBID_ATTR: ['style'],
      });
      target.querySelectorAll('a[href]').forEach((link) => {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      });
      if (global.renderMathInElement) {
        global.renderMathInElement(target, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false },
          ],
          ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        });
      }
      return true;
    } catch {
      target.textContent = source;
      return false;
    }
  }

  global.VaultMindRenderer = Object.freeze({ normalizeDisplayMath, render });
})(window);
