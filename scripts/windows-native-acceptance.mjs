#!/usr/bin/env node
// Run with the packaged Node, not a preinstalled developer runtime:
// node.exe windows-native-acceptance.mjs --backend <resources/backend> --work-dir <authorized-test-directory>
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--backend', '--work-dir', '--label'].includes(process.argv[index]) || !process.argv[index + 1]) {
    throw new Error('Usage: node.exe windows-native-acceptance.mjs --backend <resources/backend> --work-dir <authorized-test-directory> [--label <description>]');
  }
  args.set(process.argv[index], process.argv[index + 1]);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This acceptance harness must run on Windows x64. It does not simulate Windows results.');
if (!args.has('--backend') || !args.has('--work-dir')) throw new Error('--backend and --work-dir are required.');
const backendRoot = path.resolve(args.get('--backend'));
const workRoot = path.resolve(args.get('--work-dir'));
if (workRoot === path.parse(workRoot).root) throw new Error('Select a dedicated test directory, not an entire drive.');
await fs.mkdir(workRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(workRoot, 'native-acceptance-'));
const reportFile = path.join(runRoot, 'report.json');
const report = {
  schemaVersion: 1, status: 'running', label: args.get('--label') || 'supplied Windows backend',
  startedAt: new Date().toISOString(), runtime: { platform: process.platform, arch: process.arch,
    osRelease: os.release(), nodeVersion: process.version, executable: process.execPath },
  backendRoot, runRoot, files: {}, checks: [],
  notCovered: ['Electron GUI and microphone hardware', 'Electron safeStorage / DPAPI round-trip',
    'Live paid model/search providers', 'Installer upgrade/uninstall', 'A separate clean Windows 10 and Windows 11 machine'],
};
const children = new Set();
const evidence = (message) => process.stdout.write(`${message}\n`);
async function writeReport() {
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const lines = [`Windows native acceptance: ${report.status}`, `Runtime: ${process.version}; Windows ${os.release()}; ${process.arch}`,
    `Backend: ${backendRoot}`, `Artifacts: ${runRoot}`, '',
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.error ? `: ${check.error.message}` : ''}`),
    '', 'Not covered by this harness:', ...report.notCovered.map((item) => `- ${item}`)];
  await fs.writeFile(path.join(runRoot, 'report.txt'), `${lines.join('\n')}\n`, 'utf8');
}
function stopChildren() { for (const child of children) { try { child.kill(); } catch {} } }
const deadline = setTimeout(() => {
  report.status = 'timed-out'; report.finishedAt = new Date().toISOString();
  stopChildren(); void writeReport().finally(() => process.exit(2));
}, 180_000);
process.once('SIGINT', () => { stopChildren(); process.exit(130); });
process.once('SIGTERM', () => { stopChildren(); process.exit(143); });

async function check(name, action) {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - started, ...(details ? { evidence: details } : {}) });
    evidence(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - started,
      error: { code: String(error.code || error.name), message: String(error.message).slice(0, 2000), stack: String(error.stack || '').slice(0, 6000) } });
    evidence(`FAIL ${name}: ${error.message}`);
  }
  await writeReport();
}
async function hashFile(relative) {
  const bytes = await fs.readFile(path.join(backendRoot, relative));
  report.files[relative] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function childProcess(code, ipc = false) {
  const child = spawn(process.execPath, ['-e', code], {
    cwd: runRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', ...(ipc ? ['ipc'] : [])],
    env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows', TEMP: runRoot, TMP: runRoot },
  });
  children.add(child); child.on('exit', () => children.delete(child));
  child.stderr.on('data', () => {});
  return child;
}
async function expectGone(pid, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} (PID ${pid}) survived Job Object termination.`);
}

try {
  for (const filename of ['platform/native/SecondMind.Platform.exe', 'platform/native/SecondMind.Platform.exe.config',
    'platform/private-storage.mjs', 'src/path-policy.mjs', 'src/original/knowledge-inventory.mjs']) await hashFile(filename);
  const storage = await import(pathToFileURL(path.join(backendRoot, 'platform/private-storage.mjs')));
  const { VaultPathPolicy } = await import(pathToFileURL(path.join(backendRoot, 'src/path-policy.mjs')));
  const { KnowledgeInventories } = await import(pathToFileURL(path.join(backendRoot, 'src/original/knowledge-inventory.mjs')));
  const helper = path.join(backendRoot, 'platform/native/SecondMind.Platform.exe');
  storage.setNativeHelperPath(helper);
  const privateRoot = path.join(runRoot, 'private');

  await check('native ACL protect / verify / reject Everyone grant / restore', async () => {
    await storage.protectPrivateDirectory(privateRoot);
    await storage.verifyPrivatePath(privateRoot);
    const target = path.join(privateRoot, 'acl-fixture.json');
    await storage.atomicPrivateFile(target, Buffer.from('{"synthetic":true}'));
    await storage.verifyPrivatePath(target);
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    await promisify(execFile)(icacls, [target, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
    try { await assert.rejects(storage.verifyPrivatePath(target)); }
    finally { await storage.protectPrivatePath(target); }
    await storage.verifyPrivatePath(target);
    return { modifiedAclOnlyOn: target, wideAclRejected: true };
  });

  await check('private atomic replacement and hard-link rejection preserve previous bytes', async () => {
    await storage.protectPrivateDirectory(privateRoot);
    const target = path.join(privateRoot, 'atomic.json'), link = path.join(privateRoot, 'hard-link.json');
    await storage.atomicPrivateFile(target, Buffer.from('old'));
    await storage.atomicPrivateFile(target, Buffer.from('new'));
    assert.equal((await storage.readPrivateFile(target)).toString(), 'new');
    await fs.link(target, link);
    try {
      await assert.rejects(storage.atomicPrivateFile(target, Buffer.from('must-not-commit')));
      assert.equal(await fs.readFile(target, 'utf8'), 'new');
    } finally { await fs.unlink(link); }
    const temporaryFiles = (await fs.readdir(privateRoot)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(temporaryFiles, []);
    return { committedReplacement: true, refusedHardLink: true, temporaryFiles };
  });

  await check('Chinese / space / long paths; case folding; junction exclusion; metadata inventory', async () => {
    const vault = path.join(runRoot, '中文 知识库'), outside = path.join(runRoot, 'outside-synthetic');
    await fs.mkdir(vault); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'must-not-enumerate.md'), '# Outside synthetic note');
    await fs.writeFile(path.join(vault, '中文 笔记.md'), '# Synthetic local note');
    await fs.symlink(outside, path.join(vault, 'junction'), 'junction');
    await assert.rejects(storage.assertNoReparseTraversal(path.join(vault, 'junction')));
    const relative = `${'nested'.repeat(16)}/${'目录'.repeat(48)}/${'deep'.repeat(24)}/long-note.md`;
    const longFile = path.join(vault, ...relative.split('/'));
    assert.ok(longFile.length > 260);
    await fs.mkdir(path.dirname(longFile), { recursive: true });
    await fs.writeFile(longFile, '# Synthetic long path');
    await storage.assertNoReparseTraversal(longFile);
    const policy = await new VaultPathPolicy(vault, ['PRIVATE']).initialize();
    assert.equal(policy.isExcluded('private/key.md'), true);
    for (const unsafe of ['note.md:stream', 'NUL.md', 'trailing.', 'folder ']) assert.throws(() => policy.assertAllowed(unsafe));
    assert.equal((await policy.existingFile(relative)).relative, relative);
    const alternateDrive = path.parse(vault).root.toUpperCase() === 'C:\\' ? 'D:\\other' : 'C:\\other';
    assert.equal(storage.isInsidePath(vault, alternateDrive), false);
    const inventory = new KnowledgeInventories({ root: vault, directory: path.join(privateRoot, 'inventory') });
    await inventory.ready;
    const record = await inventory.create('acceptance', 'synthetic-conversation', { scope: 'markdown', startMs: null, endMs: null }, 'synthetic-task');
    await inventory.scan(record);
    assert.equal(record.status, 'completed', JSON.stringify(record.errors));
    assert.deepEqual(new Set(record.entries.map((entry) => entry.path)), new Set(['中文 笔记.md', relative]));
    assert.ok(record.excluded.some((entry) => entry.path === 'junction'));
    return { longestPathCharacters: longFile.length, enumeratedFiles: record.entries.length,
      junctionExcluded: true, crossDriveBoundary: 'lexical check only; no second drive file operations' };
  });

  for (const trigger of ['owner-exit', 'stdin-eof', 'watchdog-exit']) {
    await check(`Job Object terminates backend and admitted descendants on ${trigger}`, async () => {
      const owner = childProcess('setInterval(()=>{},1000)');
      const backend = childProcess(`process.on('message', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
        process.send({ pid: child.pid });
      });`, true);
      let guard, descendant;
      try {
        await Promise.all([once(owner, 'spawn', { signal: AbortSignal.timeout(5000) }), once(backend, 'spawn', { signal: AbortSignal.timeout(5000) })]);
        guard = spawn(helper, ['watch', String(owner.pid), String(backend.pid)], { cwd: runRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(guard); guard.on('exit', () => children.delete(guard));
        let output = '', stderr = '';
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Native watchdog did not reach READY: ${stderr}`)), 10_000);
          guard.once('error', (error) => { clearTimeout(timer); reject(error); });
          guard.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Native watchdog exited ${code}: ${stderr}`)); });
          guard.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
          guard.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (/(?:^|\n)READY\r?\n/.test(output)) { clearTimeout(timer); resolve(); }
          });
        });
        const message = once(backend, 'message', { signal: AbortSignal.timeout(5000) });
        backend.send({ type: 'start' });
        [{ pid: descendant }] = await message;
        assert.ok(Number.isSafeInteger(descendant));
        process.kill(descendant, 0);
        const exited = once(backend, 'exit', { signal: AbortSignal.timeout(5000) });
        if (trigger === 'owner-exit') owner.kill();
        else if (trigger === 'stdin-eof') guard.stdin.end();
        else guard.kill();
        await exited;
        await expectGone(descendant, 'Admitted descendant');
        return { backendPid: backend.pid, descendantPid: descendant, terminated: true, startAdmittedAfterReady: true };
      } finally {
        owner.kill(); backend.kill(); guard?.kill();
        if (descendant) { try { process.kill(descendant); } catch {} }
      }
    });
  }
  report.status = report.checks.some((item) => item.status === 'failed') ? 'failed' : 'passed';
} catch (error) {
  report.status = 'failed'; report.setupError = { code: String(error.code || error.name), message: String(error.message), stack: String(error.stack || '') };
  evidence(`SETUP FAILED: ${error.message}`);
} finally {
  clearTimeout(deadline); stopChildren();
  report.finishedAt = new Date().toISOString();
  await writeReport();
  evidence(`Report: ${reportFile}`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
