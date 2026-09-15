import path from 'node:path';

function sourceError(status, code, message) {
  return Object.assign(new Error(message), { status, code, publicMessage: true });
}

// Resolution only discovers readable files; the file endpoint still performs
// its own access checks when the browser subsequently requests the content.
export async function resolveSource(reference, { existingFile, walk }) {
  const input = typeof reference === 'string' ? reference.trim().normalize('NFC') : '';
  if (!input || input.length > 4096 || /^[\/]|^[a-z][a-z0-9+.-]*:/iu.test(input)
    || /[\\\u0000-\u001f\u007f]/u.test(input)
    || input.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw sourceError(400, 'INVALID_KNOWLEDGE_PATH', '来源路径不合法。');
  }
  const names = path.posix.extname(input) ? [input] : [input, `${input}.md`];
  for (const name of names) {
    try {
      return { path: (await existingFile(name)).relative };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const candidates = [];
  for await (const filename of walk()) {
    if (!names.some((name) => filename.endsWith(`/${name}`))) continue;
    try {
      const file = await existingFile(filename);
      candidates.push(file.relative);
    } catch (error) {
      // Files can disappear or become inaccessible during enumeration.
      if (![400, 403, 404, 413].includes(error.status)) throw error;
    }
  }
  const unique = [...new Set(candidates)].sort();
  if (unique.length === 1) return { path: unique[0] };
  if (unique.length > 1) return { candidates: unique };
  throw sourceError(404, 'SOURCE_NOT_FOUND', '来源文件不存在，可能已移动或删除。');
}
