(function installVaultMindRenderer(global) {
  const BACKTICK = String.fromCharCode(96);

  function backtickRunEnd(source, start) {
    let end = start;
    while (source[end] === BACKTICK) end += 1;
    return end;
  }

  function matchingBacktickRunEnd(source, start, length) {
    let cursor = start;
    while (cursor < source.length) {
      const candidate = source.indexOf(BACKTICK, cursor);
      if (candidate < 0) return -1;
      const end = backtickRunEnd(source, candidate);
      if (end - candidate === length) return end;
      cursor = end;
    }
    return -1;
  }

  function splitInlineCodeParts(source) {
    const parts = [];
    let cursor = 0;
    let plainStart = 0;
    while (cursor < source.length) {
      if (source[cursor] !== BACKTICK) {
        cursor += 1;
        continue;
      }
      const openerEnd = backtickRunEnd(source, cursor);
      const closerEnd = matchingBacktickRunEnd(source, openerEnd, openerEnd - cursor);
      if (closerEnd < 0) {
        // An unmatched run is literal CommonMark text. Continue scanning so it
        // cannot accidentally protect later math through the end of the line.
        cursor = openerEnd;
        continue;
      }
      if (cursor > plainStart) parts.push({ code: false, text: source.slice(plainStart, cursor) });
      parts.push({ code: true, text: source.slice(cursor, closerEnd) });
      cursor = closerEnd;
      plainStart = closerEnd;
    }
    if (plainStart < source.length) parts.push({ code: false, text: source.slice(plainStart) });
    return parts.length ? parts : [{ code: false, text: '' }];
  }

  function splitFencedCodeParts(source) {
    const value = String(source || '');
    const lines = value.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
    const parts = [];
    let offset = 0;
    let plainStart = 0;
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const content = line.replace(/\r?\n$/u, '');
      const opener = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (!opener || (opener[1][0] === BACKTICK && opener[2].includes(BACKTICK))) {
        offset += line.length;
        index += 1;
        continue;
      }
      const fenceStart = offset;
      const marker = opener[1][0];
      const minimum = opener[1].length;
      let fenceEnd = value.length;
      let scanOffset = offset + line.length;
      let nextIndex = lines.length;
      for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
        const candidateLine = lines[candidate];
        const candidateContent = candidateLine.replace(/\r?\n$/u, '');
        const closing = candidateContent.match(/^ {0,3}(`+|~+)[ \t]*$/u);
        scanOffset += candidateLine.length;
        if (closing && closing[1][0] === marker && closing[1].length >= minimum) {
          fenceEnd = scanOffset;
          nextIndex = candidate + 1;
          break;
        }
      }
      if (fenceStart > plainStart) {
        parts.push({ code: false, text: value.slice(plainStart, fenceStart) });
      }
      parts.push({ code: true, text: value.slice(fenceStart, fenceEnd) });
      plainStart = fenceEnd;
      offset = fenceEnd;
      index = nextIndex;
    }
    if (plainStart < value.length) parts.push({ code: false, text: value.slice(plainStart) });
    return parts.length ? parts : [{ code: false, text: value }];
  }

  function normalizeBareDisplayMath(source) {
    // Some providers emit display TeX as a standalone `[... ]` line after
    // dropping the backslashes from `\[...\]`. Keep ordinary Markdown labels,
    // source tokens such as [W1], and prose brackets untouched; only repair a
    // line that contains unmistakable TeX syntax and a mathematical operator.
    return String(source || '').replace(
      /(^|\n)[ \t]*\[([^\r\n]+)\][ \t]*(?=\r?\n|$)/g,
      (match, prefix, expression) => {
        const value = String(expression || '').trim();
        const hasTexSyntax = /\\[A-Za-z]+|[_^]\s*(?:\{|[A-Za-z0-9])/u.test(value);
        const hasMathOperator = /(?:=|[+\-*/]|\\(?:approx|cdot|times|frac|sum|prod|leq|geq|in|to)\b)/u.test(value);
        if (!hasTexSyntax || !hasMathOperator) return match;
        return `${prefix}$$${value}$$`;
      },
    );
  }

  function normalizeDisplayMath(source) {
    return splitFencedCodeParts(source)
      .map((part) => {
        if (part.code) return part.text;
        // Inline code is data too. Protect it before normalizing math so an
        // example such as `\\(literal\\)` remains literal after rendering.
        return splitInlineCodeParts(part.text).map((inlinePart) => {
          if (inlinePart.code) return inlinePart.text;
          return normalizeBareDisplayMath(inlinePart.text)
            .replace(/\$\$([\s\S]*?)\$\$/g, (_match, expression) => (
              `$$${expression.replace(/\s*\r?\n\s*/g, ' ').trim()}$$`
            ))
            // CommonMark consumes the backslash in \[...\] and \(...\)
            // before KaTeX auto-render runs. Convert only explicit TeX
            // delimiters (outside code) to dollar delimiters, which marked
            // preserves verbatim for the subsequent KaTeX pass.
            .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression) => (
              `$$${expression.replace(/\s*\r?\n\s*/g, ' ').trim()}$$`
            ))
            .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression) => (
              `$${expression.replace(/\s*\r?\n\s*/g, ' ').trim()}$`
            ));
        }).join('');
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
