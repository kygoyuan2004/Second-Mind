// Actual first-download and CPU/int8 inference acceptance. No model API or user speech.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node windows-speech-acceptance.mjs --resources <installed resources> --work-dir <scratch root>');
  process.exit(0);
}
function option(name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`Required: ${name}`);
  return path.resolve(argv[index + 1]);
}
const resources = option('--resources');
const workRoot = option('--work-dir');
await fs.mkdir(workRoot, { recursive: true });
const root = await fs.mkdtemp(path.join(workRoot, 'speech-real-'));
const reportPath = path.join(root, 'report.json');
const node = path.join(resources, 'runtime', 'node', 'node.exe');
const python = path.join(resources, 'runtime', 'python', 'python.exe');
const scripts = path.join(resources, 'backend', 'src', 'scripts');
const models = path.join(root, 'models', 'faster-whisper-small');
const statusPath = path.join(root, 'models', 'status.json');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const env = {};
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
  if (process.env[name]) env[name] = process.env[name];
}
for (const name of ['tmp', 'home', 'cache', 'models']) await fs.mkdir(path.join(root, name));
Object.assign(env, {
  SystemRoot: systemRoot, WINDIR: systemRoot,
  PATH: [path.dirname(node), path.dirname(python), path.join(systemRoot, 'System32')].join(path.delimiter),
  HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'home', 'config'),
  KNOWLEDGE_MEDIA_RUNTIME: '1', KNOWLEDGE_SPEECH_MODEL_DIR: models,
  KNOWLEDGE_MEDIA_MODEL_STATUS: statusPath, KNOWLEDGE_SPEECH_MODEL: 'small',
  HF_HOME: path.join(root, 'cache', 'huggingface'), HF_HUB_DISABLE_TELEMETRY: '1',
  HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', CUDA_VISIBLE_DEVICES: '',
});
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  resources, directory: root, actualInference: true, model: 'small', device: 'cpu', computeType: 'int8',
  fixtureSource: 'Windows System.Speech synthetic voice; no recorded user speech',
  network: 'Public pinned Hugging Face model download only; no paid model API', checks: [],
};
let active;
let interrupted = false;
async function terminate() {
  interrupted = true;
  if (!active?.pid) return;
  await new Promise((resolve) => {
    const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(active.pid), '/T', '/F'], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    killer.once('error', resolve); killer.once('close', resolve);
  });
}
process.once('SIGINT', () => { void terminate(); });
process.once('SIGTERM', () => { void terminate(); });
async function persist() { await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function step(name, action) {
  const before = Date.now();
  try {
    const details = await action();
    const result = { name, status: 'passed', durationMs: Date.now() - before, details };
    report.checks.push(result); console.log(JSON.stringify(result)); await persist(); return details;
  } catch (error) {
    const result = { name, status: 'failed', durationMs: Date.now() - before, error: error?.stack || String(error) };
    report.checks.push(result); console.log(JSON.stringify(result)); await persist(); throw error;
  }
}
async function run(file, args, { timeoutMs = 60_000, offline = false } = {}) {
  if (interrupted) throw new Error('Acceptance run cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: { ...env, ...(offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}) }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void terminate(); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-100_000); });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-100_000); });
    child.once('error', (error) => { clearTimeout(timer); if (active === child) active = null; reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer); if (active === child) active = null;
      if (code === 0 && !timedOut && !interrupted) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${path.basename(file)} ${timedOut ? 'timed out' : `exited ${code}`}\n${stderr}\n${stdout}`));
    });
  });
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

try {
  await step('installed-node-and-cpu-int8-capability', async () => {
    assert.equal(process.platform, 'win32');
    assert.equal((await fs.realpath(process.execPath)).toLowerCase(), (await fs.realpath(node)).toLowerCase());
    const value = await run(python, ['-B', '-X', 'utf8', '-c', "import json, ctranslate2; t=sorted(ctranslate2.get_supported_compute_types('cpu')); assert 'int8' in t; print(json.dumps(t))"]);
    return { executable: process.execPath, supported: JSON.parse(value.stdout) };
  });
  const fixture = await step('create-windows-sapi-synthetic-speech', async () => {
    const audioFile = path.join(root, '合成 语音.wav');
    const payload = Buffer.from(JSON.stringify({ audioFile }), 'utf8').toString('base64');
    const source = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  $voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
  if ($voice) {
    $language = 'zh'
    $text = '这是第二大脑桌面程序的本地语音测试。今天我们检查知识库和视频处理功能。'
  } else {
    $voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'en*' } | Select-Object -First 1
    if (-not $voice) { throw 'No enabled Chinese or English SAPI voice is installed' }
    $language = 'en'
    $text = 'This is a local speech test for the Second Mind desktop application. Today we check the knowledge base and video processing.'
  }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = -1
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($inputData.audioFile, $format)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  @{ audioFile=$inputData.audioFile; voice=$voice.VoiceInfo.Name; culture=$voice.VoiceInfo.Culture.Name; language=$language; text=$text } | ConvertTo-Json -Compress
} finally { $synth.Dispose() }
`;
    const result = await run(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
    const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    assert.ok((await fs.stat(audioFile)).size > 32_000);
    return value;
  });
  await step('first-use-pinned-model-download', async () => {
    assert.equal(await fs.access(path.join(models, '.complete.json')).then(() => true, () => false), false);
    let last = '';
    const poll = setInterval(() => {
      void fs.readFile(statusPath, 'utf8').then((value) => {
        const status = JSON.parse(value);
        const current = JSON.stringify(status);
        if (current !== last) { last = current; console.log(JSON.stringify({ progress: 'speech-model', ...status })); }
      }).catch(() => {});
    }, 2000);
    try {
      await run(python, ['-B', '-X', 'utf8', path.join(scripts, 'media_model.py')], { timeoutMs: 45 * 60_000 });
      const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));
      assert.equal(status.state, 'ready');
      return status;
    } finally { clearInterval(poll); }
  });
  await step('downloaded-model-file-sha256', async () => {
    const lock = JSON.parse(await fs.readFile(path.join(scripts, 'media-model-lock.json'), 'utf8'));
    const files = [];
    for (const entry of lock.files) {
      const file = path.join(models, entry.name);
      assert.equal((await fs.stat(file)).size, entry.size);
      const actual = await hash(file);
      assert.equal(actual, entry.sha256, entry.name);
      files.push({ name: entry.name, bytes: entry.size, sha256: actual });
    }
    return { repository: lock.repository, revision: lock.revision, files };
  });
  await step('real-offline-cpu-int8-transcription', async () => {
    // Forbid sockets during actual inference as well as setting offline Hub flags.
    // WhisperModel remains the actual installed faster-whisper implementation.
    const target = path.join(scripts, 'transcribe-audio.py');
    const wrapper = path.join(root, 'run-offline-inference.py');
    await fs.writeFile(wrapper, `import runpy, socket, sys
def no_network(*args, **kwargs):
    raise RuntimeError('Network is forbidden during actual inference')
socket.create_connection = no_network
socket.socket.connect = no_network
sys.argv[0] = ${JSON.stringify(target)}
runpy.run_path(${JSON.stringify(target)}, run_name='__main__')
`);
    const result = await run(python, ['-B', '-X', 'utf8', wrapper, fixture.audioFile, '--model', 'small', '--language', fixture.language], { timeoutMs: 15 * 60_000, offline: true });
    assert.ok(result.stdout.length > 8, 'The synthetic speech produced no meaningful transcript');
    const expected = fixture.language === 'zh'
      ? [['语音', '語音'], ['测试', '測試'], ['知识库', '知識庫'], ['视频', '視頻']]
      : [['speech'], ['test'], ['knowledge'], ['video']];
    const recognized = expected.map((variants) => variants.find((word) => result.stdout.toLowerCase().includes(word))).filter(Boolean);
    assert.ok(recognized.length >= 2, `Too few expected words recognized: ${result.stdout}`);
    return { transcript: result.stdout, expectedWordsRecognized: recognized, model: 'small', device: 'cpu', computeType: 'int8', networkDuringInference: 'blocked' };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error?.stack || String(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ status: report.status, reportPath, directory: root, actualInference: true }));
}
