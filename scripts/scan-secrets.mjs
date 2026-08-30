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
  /(^|\/)\.obsidian\//,
  /(^|\/)node_modules\//,
];
const contentPatterns = [
  { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'OpenAI-style secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'absolute user-home path', regex: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g },
];

const privateTerms = String(process.env.VAULTMIND_PRIVATE_SCAN_TERMS || '')
  .split(',').map((item) => item.trim()).filter(Boolean);
if (privateTerms.length) {
  const escaped = privateTerms.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  contentPatterns.push({
    name: 'operator-supplied private term',
    regex: new RegExp(escaped.join('|'), 'gi'),
  });
}

const findings = [];
for (const relative of listed.stdout.split('\0').filter(Boolean)) {
  if (forbiddenFiles.some((pattern) => pattern.test(relative))) {
    findings.push(`${relative}: forbidden private/runtime path`);
    continue;
  }
  const filename = path.join(root, relative);
  const stat = await fsp.stat(filename).catch(() => null);
  if (!stat?.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const buffer = await fsp.readFile(filename);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const pattern of contentPatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) findings.push(`${relative}: ${pattern.name}`);
  }
}

if (findings.length) {
  console.error(['Potential publication blockers:', ...findings.map((item) => `- ${item}`)].join('\n'));
  process.exitCode = 1;
} else {
  console.log('Secret and private-path scan passed.');
}
