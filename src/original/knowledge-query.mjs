// Extract the subject of a term lookup. If a question carries additional
// subject matter that cannot be separated confidently, keep ordinary retrieval.
const occurrence = /出现|提到|提及|提过|包含|写过|记载|记录过|有没有|有无|哪些(?:笔记|文件|文档)(?:里面|里|中)?有/u;
const notes = /笔记|知识库|文档|文件|原文/u;
export function noteTermLookup(query) {
  const text = String(query || '').normalize('NFKC').trim().replace(/[?？!！。]+$/u, '').trim();
  const inNotes = notes.test(text) && occurrence.test(text);
  const quoted = [...text.matchAll(/[“「『"`]([^”」』"`\n]+)[”」』"`]/gu)].map(m => m[1].trim()).filter(Boolean);
  if (quoted.length && (inNotes || quoted[0].length + 2 === text.length)) return { terms: [...new Set(quoted)], inNotes };
  const plain = text.replace(/^(?:(?:请问|请|帮我|告诉我|我想知道|查一下|查找|搜一下|找一下)\s*)+/u, '');
  const bareTerm = /^[A-Za-z_$][\w$+.#-]*$/u.test(plain);
  let subject = bareTerm ? plain : plain.match(/^([^，,。?!？；;\n]{1,80}?)(?:是什么|是什么意思|是指什么|指什么|是啥)/u)?.[1];
  subject ||= plain.match(/^(?:什么是|什么叫)\s*([^，,。?!？；;\n]{1,80}?)(?=[，,。?!？；;\n]|$)/u)?.[1];
  if (!subject && inNotes) {
    subject = plain.match(/^([^，,。?!？；;\n]{1,80}?)(?:这个词|这一术语)?(?:有没有|是否)?在(?:我(?:的)?|这些|这份|哪(?:些|篇|个))?(?:知识库|笔记|文档|文件|原文)/u)?.[1]
      || plain.match(/(?:出现|提到|提及|提过|包含|写过|记载|记录过)(?:过|了)?\s*([^，,。?!？；;\n]{1,80}?)(?:这个词|这个术语)?(?:吗|么|呢)?$/u)?.[1]
      || plain.match(/(?:笔记|知识库|原文|文件|文档)(?:里面|里|中)?(?:有没有|有无|有)\s*(.+?)(?:这个词|这个术语)?$/u)?.[1];
  }
  if (!subject) return null;
  const terms = subject.trim().replace(/的?(?:区别|差别|异同|关系)$/u, '').split(/\s*(?:和|与|以及|、)\s*/u);
  if (terms.some(term => /^(?:它|它们|他|她|那|这|出现过?|提到过?|提过)$/u.test(term))) return null;
  if (terms.some(term => !term || term.length > 64 || /笔记|文件|(?:我的?|你|这个|哪些|什么|之前|对应|有没有|是否|上周|最近|请问)/u.test(term))) return null;
  if (!terms.every(term => /^[A-Za-z_$][\w$+#.-]*(?: [A-Za-z0-9_$+#.-]+)*$/u.test(term)
    || (inNotes && /^[\p{Script=Han}A-Za-z0-9_+#-]+$/u.test(term)))) return null;
  return { terms: [...new Set(terms)], inNotes };
}

function keywordSurfaceVariants(term) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term);
  if (!date) return [term];
  const [, year, paddedMonth, paddedDay] = date;
  const month = String(Number(paddedMonth));
  const day = String(Number(paddedDay));
  return [
    term,
    `${year}-${month}-${day}`,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${year}/${month}/${day}`,
    `${year}.${paddedMonth}.${paddedDay}`,
    `${year}.${month}.${day}`,
    `${year}年${paddedMonth}月${paddedDay}日`,
    `${year}年${month}月${day}日`,
  ];
}

function normalizedDisplayMap(value) {
  let normalized = '';
  const starts = [];
  let offset = 0;
  for (const symbol of String(value || '')) {
    const start = offset;
    offset += symbol.length;
    const folded = symbol.normalize('NFKC').toLocaleLowerCase('zh-CN');
    normalized += folded;
    for (let index = 0; index < folded.length; index += 1) starts.push(start);
  }
  return { normalized, starts };
}

function keywordSurfaceIndex(line, matchedTerms) {
  const display = normalizedDisplayMap(line);
  let earliest = -1;
  for (const term of matchedTerms) {
    for (const variant of keywordSurfaceVariants(term)) {
      const found = display.normalized.indexOf(variant.normalize('NFKC').toLocaleLowerCase('zh-CN'));
      if (found < 0) continue;
      const original = display.starts[found] ?? found;
      if (earliest < 0 || original < earliest) earliest = original;
    }
  }
  return earliest;
}

// Preserve source offsets when full-width characters or dates normalize differently.
export function matchedLineExcerpt(line, terms, length = 260) {
  const index = keywordSurfaceIndex(line, terms);
  const start = Math.max(0, index - Math.floor(length / 3));
  const raw = line.slice(start, start + length);
  const quote = raw.trim();
  return { quote, snippet: (start ? '…' : '') + quote.replace(/\s+/gu, ' ') + (start + length < line.length ? '…' : '') };
}
