import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) throw new Error(listed.stderr || 'Unable to list repository files.');

const forbiddenFiles = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)/,
  /(^|\/)data\/(?!\.gitkeep$)/,
  /(^|\/)vault\/(?!\.gitkeep$)/,
  /(^|\/)conversations\.json$/i,
  /(^|\/)(?:settings|runtime-config|credentials?)\.json$/i,
  /(^|\/)(?:id_rsa|id_ed25519|authorized_keys)$/i,
  /\.(?:pem|p12|pfx|jks|keystore)$/i,
  /\.(?:zip|7z|rar|tgz|tar|gz)$/i,
  /(^|\/)\.obsidian\//,
  /(^|\/)node_modules\//,
];
const contentPatterns = [
  { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'OpenAI-style secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'Stripe live secret', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g },
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  {
    name: 'absolute user-home path',
    regex: /(?:\/(?:home|Users)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\r\n]+\\)/g,
  },
];

const privateTerms = [
  process.env.SECOND_MIND_PRIVATE_SCAN_TERMS,
  process.env.VAULTMIND_PRIVATE_SCAN_TERMS,
].flatMap((value) => String(value || '').split(','))
  .map((item) => item.trim()).filter(Boolean);
if (privateTerms.length) {
  const escaped = [...new Set(privateTerms)]
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  contentPatterns.push({
    name: 'operator-supplied private term',
    regex: new RegExp(escaped.join('|'), 'gi'),
  });
}

const findings = [];
function add(relative, category, position = '') {
  findings.push(`${relative}${position ? `:${position}` : ''}: ${category}`);
}

const dockerignore = await fsp.readFile(path.join(root, '.dockerignore'), 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
for (const [index, sourceLine] of dockerignore.split(/\r?\n/u).entries()) {
  const line = sourceLine.trim();
  if (line.startsWith('!') && /[*?[\]{}]/u.test(line.slice(1))) {
    add('.dockerignore', 'wildcard build-context re-include', String(index + 1));
  }
}

function lineAt(text, index) {
  return String(text.slice(0, index).split('\n').length);
}

function pngMetadata(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return [];
  const disallowed = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'caBX']);
  const output = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (disallowed.has(type)) output.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return output;
}

function binaryMetadata(relative, buffer) {
  const extension = path.extname(relative).toLowerCase();
  if (extension === '.png') {
    for (const chunk of pngMetadata(buffer)) add(relative, `embedded PNG metadata (${chunk})`);
  }
  if (['.jpg', '.jpeg'].includes(extension) && (
    buffer.includes(Buffer.from('Exif\0\0', 'binary')) || buffer.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))
  )) add(relative, 'embedded JPEG EXIF/XMP metadata');
  if (extension === '.webp' && (
    buffer.includes(Buffer.from('EXIF')) || buffer.includes(Buffer.from('XMP '))
  )) add(relative, 'embedded WebP EXIF/XMP metadata');
  if (extension === '.gif' && buffer.includes(Buffer.from([0x21, 0xfe]))) {
    add(relative, 'embedded GIF comment metadata');
  }
  if (buffer.subarray(0, 43).toString('utf8').startsWith('version https://git-lfs.github.com/spec/')) {
    add(relative, 'Git LFS pointer requires separate object review');
  }
}

for (const relative of listed.stdout.split('\0').filter(Boolean)) {
  if (forbiddenFiles.some((pattern) => pattern.test(relative))) {
    add(relative, 'forbidden private/runtime path');
    continue;
  }
  const filename = path.join(root, relative);
  const stat = await fsp.stat(filename).catch(() => null);
  if (!stat?.isFile()) continue;
  if (stat.size > 20 * 1024 * 1024) {
    add(relative, 'file exceeds publication scanner size limit');
    continue;
  }
  const buffer = await fsp.readFile(filename);
  binaryMetadata(relative, buffer);
  const binary = buffer.includes(0);
  // UTF-8 catches source and CJK denylist terms. Latin-1 catches ASCII token
  // markers inside otherwise binary formats without attempting decompression.
  const texts = binary
    ? [buffer.toString('utf8'), buffer.toString('latin1')]
    : [buffer.toString('utf8')];
  for (const pattern of contentPatterns) {
    let matched = false;
    for (const text of texts) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text))) {
        add(relative, pattern.name, binary ? 'binary' : lineAt(text, match.index));
        matched = true;
        // One location per category is sufficient and avoids noisy duplicate
        // reports for binary UTF-8/Latin-1 views.
        break;
      }
      if (matched) break;
    }
  }
}

if (findings.length) {
  console.error(['Potential publication blockers:', ...findings.map((item) => `- ${item}`)].join('\n'));
  process.exitCode = 1;
} else {
  console.log('Secret and private-path scan passed.');
}
