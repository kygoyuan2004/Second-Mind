export function passageHeadings(text, lineNumber) {
  const headings = [];
  let fence = '';
  let frontmatter = false;
  for (const [index, line] of text.split('\n', lineNumber).entries()) {
    if (index === 0 && line.trim() === '---') { frontmatter = true; continue; }
    if (frontmatter) {
      if (/^(---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
      continue;
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (delimiter?.[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
      continue;
    }
    if (delimiter) { fence = delimiter[1]; continue; }
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      headings.length = heading[1].length;
      headings[headings.length - 1] = heading[2].replace(/\s+#+\s*$/u, '').trim();
    }
  }
  return headings.filter(Boolean);
}

// A line hint disambiguates repeated verbatim text.
export function locatePassage(text, quote, line = 0) {
  if (!quote || quote.length > 640) return null;
  const first = text.indexOf(quote);
  if (first < 0) return null;
  let index = first;
  if (text.indexOf(quote, first + 1) >= 0) {
    if (!Number.isSafeInteger(line) || line < 1) return null;
    let start = 0;
    for (let i = 1; i < line; i++) {
      start = text.indexOf('\n', start) + 1;
      if (!start) return null;
    }
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    index = text.indexOf(quote, start);
    const next = text.indexOf(quote, index + 1);
    if (index < start || index >= end || (next >= 0 && next < end)) return null;
  }
  return { index, line: 1 + (text.slice(0, index).match(/\n/g) || []).length };
}
