// Standalone: execute with the INSTALLED resources/runtime/node/node.exe.
// No npm install, network access, speech-model download, or model API is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node windows-media-acceptance.mjs --resources <installed resources> --work-dir <scratch root>');
  process.exit(0);
}
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Required: ${name}`);
  return path.resolve(args[index + 1]);
}
const resources = option('--resources');
const workRoot = option('--work-dir');
await fs.mkdir(workRoot, { recursive: true });
const directory = await fs.mkdtemp(path.join(workRoot, 'media-smoke-'));
const reportFile = path.join(directory, 'report.json');
const report = {
  platform: process.platform, architecture: process.arch, node: process.version,
  executable: process.execPath, resources, directory, startedAt: new Date().toISOString(),
  networkCalls: 'none', speechModelDownload: 'not-run',
  actualSpeechInference: 'not-run; command-pipeline checks use an explicit deterministic Whisper test double',
  checks: [],
};
const node = path.join(resources, 'runtime', 'node', 'node.exe');
const python = path.join(resources, 'runtime', 'python', 'python.exe');
const ffmpeg = path.join(resources, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe');
const ffprobe = path.join(resources, 'runtime', 'ffmpeg', 'bin', 'ffprobe.exe');
const backend = path.join(resources, 'backend');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const environment = {};
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
  if (process.env[name]) environment[name] = process.env[name];
}
for (const name of ['home', 'tmp', 'cache', 'config']) await fs.mkdir(path.join(directory, name));
Object.assign(environment, {
  SystemRoot: systemRoot, WINDIR: systemRoot,
  PATH: [path.dirname(node), path.dirname(python), path.dirname(ffmpeg), path.join(systemRoot, 'System32')].join(path.delimiter),
  HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'),
  TEMP: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'), TMPDIR: path.join(directory, 'tmp'),
  XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_CONFIG_HOME: path.join(directory, 'config'),
  HF_HOME: path.join(directory, 'cache', 'huggingface'), HF_HUB_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
  TRANSFORMERS_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '',
  KNOWLEDGE_MEDIA_RUNTIME: '0', KNOWLEDGE_SPEECH_PYTHON: python,
  KNOWLEDGE_VIDEO_FFMPEG: ffmpeg, KNOWLEDGE_VIDEO_YTDLP: python,
  KNOWLEDGE_VIDEO_YTDLP_MODULE: '1', DATA_DIR: path.join(directory, 'state'),
});
// Installed media classes spawn from process.env. Do not inherit host credentials,
// Python paths, model settings, or installed developer tools into this test.
process.env = environment;

async function persist() { await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); }
async function check(name, action) {
  const start = Date.now();
  try {
    const details = await action();
    const result = { name, status: 'passed', durationMs: Date.now() - start, details };
    report.checks.push(result); console.log(JSON.stringify(result));
    await persist();
    return details;
  } catch (error) {
    const result = { name, status: 'failed', durationMs: Date.now() - start, error: error?.stack || String(error) };
    report.checks.push(result); console.log(JSON.stringify(result));
    await persist();
    throw error;
  }
}
async function stopPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  await new Promise((resolve) => {
    const child = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      env: environment, cwd: directory, stdio: 'ignore', shell: false, windowsHide: true,
    });
    child.once('error', resolve); child.once('close', resolve);
  });
}
async function run(command, arguments_, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: directory, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stopPid(child.pid); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${path.basename(command)} ${timedOut ? 'timed out' : `exited ${code}`}\n${stderr}\n${stdout}`));
    });
  });
}
const py = (code) => run(python, ['-B', '-X', 'utf8', '-c', code]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

try {
  await check('installed-binaries-and-isolated-environment', async () => {
    assert.equal(process.platform, 'win32', 'This acceptance harness requires native Windows');
    assert.equal(process.arch, 'x64');
    assert.equal((await fs.realpath(process.execPath)).toLowerCase(), (await fs.realpath(node)).toLowerCase(), 'Run with the installed bundled Node');
    for (const file of [python, ffmpeg, ffprobe]) assert.ok((await fs.stat(file)).isFile());
    return { node: process.execPath, python, ffmpeg, ffprobe, hostToolsInPath: false };
  });

  await check('python-native-dll-imports-and-cpu-int8', async () => {
    const result = await py(`import sys, json, importlib.metadata as m
import av, numpy, ctranslate2, faster_whisper, onnxruntime, tokenizers, huggingface_hub, yt_dlp, yt_dlp_ejs
types = sorted(ctranslate2.get_supported_compute_types('cpu'))
assert 'int8' in types, types
assert sys.flags.utf8_mode == 1
assert sys.dont_write_bytecode
print(json.dumps({'python': sys.version, 'executable': sys.executable, 'computeTypes': types,
    'packages': {name: m.version(name) for name in ['av','numpy','ctranslate2','faster-whisper','onnxruntime','tokenizers','huggingface-hub','yt-dlp','yt-dlp-ejs']}}, ensure_ascii=False))`);
    return JSON.parse(result.stdout);
  });

  await check('ffmpeg-ffprobe-and-downloader-versions', async () => {
    const [encode, probe, downloader] = await Promise.all([
      run(ffmpeg, ['-version']), run(ffprobe, ['-version']),
      run(python, ['-B', '-X', 'utf8', '-m', 'yt_dlp', '--no-config', '--version']),
    ]);
    return { ffmpeg: encode.stdout.split('\n')[0], ffprobe: probe.stdout.split('\n')[0], ytDlp: downloader.stdout };
  });

  const unicodeDirectory = path.join(directory, '中文 空格');
  await fs.mkdir(unicodeDirectory);
  const audioFile = path.join(unicodeDirectory, '原始 语音.wav');
  const videoFile = path.join(unicodeDirectory, '演示 视频.mp4');
  await check('generate-local-audio-and-video-with-chinese-paths', async () => {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '1', '-ac', '1', '-c:a', 'pcm_s16le', audioFile]);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '1.5', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest', videoFile]);
    assert.ok((await fs.stat(audioFile)).size > 16_000);
    assert.ok((await fs.stat(videoFile)).size > 1_000);
    return { audioFile, videoFile };
  });

  const { KnowledgeVideoProcessor } = await import(pathToFileURL(path.join(backend, 'src', 'original', 'knowledge-video.mjs')));
  const { KnowledgeTranscriber } = await import(pathToFileURL(path.join(backend, 'src', 'original', 'knowledge-transcriber.mjs')));
  const processor = new KnowledgeVideoProcessor({ tempRoot: path.join(unicodeDirectory, '视频 处理'), python, ffmpeg, ytdlp: python, ytdlpModule: true });
  await processor.ready;
  const metadata = await check('installed-video-inspector-with-pyav', async () => {
    const value = await processor.inspect(videoFile);
    assert.equal(value.video.width, 160);
    assert.equal(value.video.height, 120);
    assert.ok(value.durationSeconds >= 1 && value.durationSeconds < 3);
    assert.ok(value.audio?.sampleRate > 0);
    return value;
  });
  await check('installed-thumbnail-command-pipeline', async () => {
    const output = path.join(unicodeDirectory, '关键帧');
    await fs.mkdir(output);
    const frames = await processor.extractFrames(videoFile, output, metadata.durationSeconds);
    assert.ok(frames.length >= 1);
    for (const frame of frames) assert.equal(frame.buffer.subarray(0, 2).toString('hex'), 'ffd8');
    return { count: frames.length, names: frames.map((frame) => frame.name) };
  });

  // The real transcription scripts and Node wrappers run unchanged. Only the
  // Whisper model object is replaced; native PyAV decodes the generated media.
  // This proves command, path, encoding, validation and output handling, and is
  // explicitly not evidence of real speech recognition quality or model loading.
  const transcript = '桌面语音流程验证 🎧';
  async function fakeWhisperScript(targetName) {
    const target = path.join(backend, 'src', 'scripts', targetName);
    const wrapper = path.join(unicodeDirectory, `测试-${targetName}`);
    const source = `import sys, os, runpy, types, socket
import av
os.environ['KNOWLEDGE_MEDIA_RUNTIME'] = '0'
def no_network(*args, **kwargs):
    raise RuntimeError('Network is forbidden in this acceptance check')
socket.create_connection = no_network
socket.socket.connect = no_network
class FakeWhisperModel:
    def __init__(self, model, device, compute_type):
        assert model == 'small', model
        assert device == 'cpu', device
        assert compute_type == 'int8', compute_type
    def transcribe(self, filename, **kwargs):
        with av.open(filename) as container:
            assert container.streams.audio
            stream = container.streams.audio[0]
            assert next(container.decode(stream)).samples > 0
        return iter([types.SimpleNamespace(start=0.0, end=1.0, text=${JSON.stringify(transcript)})]), types.SimpleNamespace(language='zh', language_probability=1.0)
sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=FakeWhisperModel)
sys.argv[0] = ${JSON.stringify(target)}
runpy.run_path(${JSON.stringify(target)}, run_name='__main__')
`;
    await fs.writeFile(wrapper, source);
    return wrapper;
  }
  await check('installed-audio-transcription-command-with-explicit-model-double', async () => {
    const script = await fakeWhisperScript('transcribe-audio.py');
    const transcriber = new KnowledgeTranscriber({ python, script, model: 'small', tempRoot: path.join(unicodeDirectory, '录音 处理') });
    assert.equal((await transcriber.status()).available, true);
    const result = await transcriber.transcribe('smoke-user', { type: 'audio/wav', durationMs: 1000, data: (await fs.readFile(audioFile)).toString('base64') });
    assert.equal(result.text, transcript);
    assert.equal(result.durationMs, 1000);
    return { text: result.text, actualModelInference: false };
  });
  await check('installed-video-transcription-command-with-explicit-model-double', async () => {
    processor.transcribeScript = await fakeWhisperScript('transcribe-video.py');
    const output = path.join(unicodeDirectory, '视频 转写');
    await fs.mkdir(output);
    const result = await processor.transcribe(videoFile, output);
    const payload = JSON.parse(await fs.readFile(path.join(output, 'transcript.json'), 'utf8'));
    assert.equal(payload.segments[0].text, transcript);
    assert.ok(JSON.stringify(result).includes(transcript));
    return { segments: payload.segments, actualModelInference: false };
  });

  await check('cancel-installed-video-process-and-ffmpeg-descendant', async () => {
    const wrapper = path.join(unicodeDirectory, '取消 测试.mjs');
    const pidFile = path.join(unicodeDirectory, '取消-pids.json');
    await fs.writeFile(wrapper, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], ['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-f','null','-'], { stdio: 'ignore', windowsHide: true, shell: false });
child.on('spawn', () => fs.writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, descendant: child.pid })));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const running = processor.runProcess(node, [wrapper, ffmpeg, pidFile], { cwd: unicodeDirectory, signal: controller.signal, timeoutMs: 30_000 });
    // Observe rejection immediately to avoid an unhandled-rejection race on fast cancellation.
    const completion = running.then(() => ({ succeeded: true }), (error) => ({ error }));
    let pids;
    try {
      for (let attempt = 0; attempt < 100 && !pids; attempt++) {
        try { pids = JSON.parse(await fs.readFile(pidFile, 'utf8')); } catch { await pause(100); }
      }
      assert.ok(pids?.parent > 0 && pids?.descendant > 0, 'Media descendant did not start');
      await pause(250);
      assert.equal(await alive(pids.descendant), true, 'FFmpeg exited before cancellation');
      controller.abort();
      const outcome = await completion;
      assert.equal(outcome.error?.code, 'VIDEO_CANCELLED', String(outcome.error || 'Unexpected successful task'));
      for (let attempt = 0; attempt < 100 && (await alive(pids.parent) || await alive(pids.descendant)); attempt++) await pause(100);
      assert.equal(await alive(pids.parent), false, 'Parent media process survived cancellation');
      assert.equal(await alive(pids.descendant), false, 'FFmpeg descendant survived cancellation');
      return { ...pids, bothStopped: true };
    } finally {
      controller.abort();
      if (pids) { await stopPid(pids.parent); await stopPid(pids.descendant); }
      await completion;
    }
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify({ status: report.status, reportFile, checks: report.checks.length, actualSpeechInference: false }));
}
