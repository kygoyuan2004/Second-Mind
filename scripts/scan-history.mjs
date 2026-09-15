import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const image = 'zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
const commits = spawnSync('git', ['rev-list', '--all', '--count'], { cwd: root, encoding: 'utf8' });
if (common.status !== 0 || commits.status !== 0 || !Number(commits.stdout.trim())) {
  console.error('Full-history scan requires a valid repository with reachable commits.');
  process.exit(1);
}
const result = spawnSync('docker', [
  'run',
  '--rm',
  '--network',
  'none',
  '--volume',
  `${root}:/repo:ro`,
  '--volume', `${common.stdout.trim()}:/gitmeta:ro`,
  '--env', 'GIT_DIR=/gitmeta',
  '--env', 'GIT_WORK_TREE=/repo',
  image,
  'detect',
  '--source=/repo',
  '--log-opts=--all',
  '--gitleaks-ignore-path=/repo/.gitleaksignore',
  '--redact=100',
  '--no-banner',
  '--no-color',
], {
  cwd: root,
  encoding: 'utf8',
});

if (result.error) {
  console.error(result.error.code === 'ENOENT'
    ? 'Full-history scan requires Docker on PATH.'
    : 'Unable to start the pinned full-history scanner.');
  process.exitCode = 1;
} else {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  if (/\bERR\b|fatal:|\b0 commits scanned\b/iu.test(`${result.stdout}\n${result.stderr}`)) {
    console.error('Full-history scan did not inspect the repository successfully.');
    process.exitCode = 1;
  }
}
