import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'node_modules');
const destination = path.join(root, 'public', 'vendor');

const files = [
  ['marked/lib/marked.umd.js', 'marked/marked.umd.js'],
  ['dompurify/dist/purify.min.js', 'dompurify/purify.min.js'],
  ['katex/dist/katex.min.js', 'katex/katex.min.js'],
  ['katex/dist/katex.min.css', 'katex/katex.min.css'],
  ['katex/dist/contrib/auto-render.min.js', 'katex/auto-render.min.js'],
];

await fsp.rm(destination, { recursive: true, force: true });
for (const [from, to] of files) {
  const target = path.join(destination, to);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(path.join(source, from), target);
}
await fsp.cp(path.join(source, 'katex', 'dist', 'fonts'), path.join(destination, 'katex', 'fonts'), {
  recursive: true,
});

console.log('Browser vendor assets synchronized.');
