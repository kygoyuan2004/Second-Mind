import { markPublicMessage } from '../public-errors.mjs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INSPECT_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'inspect-video.py');
const DEFAULT_TRANSCRIBE_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'transcribe-video.py');
const DEFAULT_TEMP_ROOT = path.resolve(process.env.DATA_DIR || 'data', 'video');
const DEFAULT_PYTHON = path.resolve(process.env.KNOWLEDGE_SPEECH_PYTHON || '/opt/media/bin/python');
const DEFAULT_YTDLP = path.resolve(process.env.KNOWLEDGE_VIDEO_YTDLP || '/opt/media/bin/yt-dlp');
const DEFAULT_FFMPEG = path.resolve(process.env.KNOWLEDGE_VIDEO_FFMPEG || '/usr/bin/ffmpeg');
const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 2 * 60 * 60;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_URL_LENGTH = 2048;
const MAX_TRANSCRIPT_CHARACTERS = 240_000;
const VIDEO_EXTENSIONS = new Map([
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.flv', 'video/x-flv'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.m4v', 'video/x-m4v'],
]);
const VIDEO_MEDIA_TYPES = new Set(VIDEO_EXTENSIONS.values());
const PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'xiaohongshu.com', 'xhslink.com',
  'douyin.com', 'iesdouyin.com', 'tiktok.com', 'vimeo.com',
];

function videoError(status, message, code = 'VIDEO_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return markPublicMessage(error);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeName(value, fallback = 'video.mp4') {
  const source = path.basename(String(value || fallback)).normalize('NFKC');
  const extension = path.extname(source).toLowerCase();
  const stem = path.basename(source, extension)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
  return `${stem}${VIDEO_EXTENSIONS.has(extension) ? extension : '.mp4'}`;
}

function supportedMedia(name, mediaType) {
  const extension = path.extname(String(name || '')).toLowerCase();
  const cleanType = String(mediaType || '').toLowerCase().split(';')[0].trim();
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { extension, mediaType: VIDEO_EXTENSIONS.get(extension) };
  }
  if (VIDEO_MEDIA_TYPES.has(cleanType)) {
    const inferred = [...VIDEO_EXTENSIONS].find(([, value]) => value === cleanType)?.[0] || '.mp4';
    return { extension: inferred, mediaType: cleanType };
  }
  return null;
}

function hostMatches(hostname, suffix) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isPlatformUrl(url) {
  return PLATFORM_HOSTS.some((suffix) => hostMatches(url.hostname, suffix));
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function isPrivateIp(address) {
  const kind = net.isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind !== 6) return true;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

async function validatePublicUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw videoError(400, '视频链接不正确。', 'INVALID_VIDEO_URL');
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw videoError(400, '视频链接不正确。', 'INVALID_VIDEO_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw videoError(400, '仅支持不包含账号密码的 HTTP/HTTPS 视频链接。', 'INVALID_VIDEO_URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw videoError(400, '不允许访问本机或内网链接。', 'PRIVATE_VIDEO_URL');
  }
  let addresses;
  try {
    addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  } catch {
    throw videoError(422, '无法解析视频链接的域名。', 'VIDEO_URL_DNS_FAILED');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw videoError(400, '不允许访问本机或内网链接。', 'PRIVATE_VIDEO_URL');
  }
  return url;
}

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const remaining = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

async function canExecute(target) {
  try { await fsp.access(target, fs.constants.X_OK); return true; }
  catch { return false; }
}

function processEnvironment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)/i.test(key)) delete env[key];
  }
  delete env.SSH_AUTH_SOCK;
  delete env.GPG_AGENT_INFO;
  return {
    ...env,
    CUDA_VISIBLE_DEVICES: '',
    PYTHONDONTWRITEBYTECODE: '1',
    HOME: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: processEnvironment(options.home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    const outputLimit = options.outputLimit || 80_000;
    const errorLimit = options.errorLimit || 12_000;
    const terminate = () => {
      aborted = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      force.unref();
    };
    const onAbort = () => terminate();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) terminate();
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs) : null;
    timer?.unref();
    child.stdout.on('data', (chunk) => { if (stdout.length < outputLimit) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < errorLimit) stderr += String(chunk); });
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(videoError(503, `视频处理工具无法启动：${error.message}`, 'VIDEO_TOOL_START_FAILED'));
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      if (aborted || options.signal?.aborted) return reject(videoError(499, '视频处理已取消。', 'VIDEO_CANCELLED'));
      if (timedOut) return reject(videoError(504, '视频处理超时。', 'VIDEO_PROCESS_TIMEOUT'));
      const detail = stderr.trim().split('\n').slice(-3).join('；') || `退出码 ${code}`;
      return reject(videoError(422, detail.slice(0, 1000), 'VIDEO_TOOL_FAILED'));
    });
  });
}

export class KnowledgeVideoProcessor {
  constructor(options = {}) {
    this.tempRoot = path.resolve(options.tempRoot || process.env.KNOWLEDGE_VIDEO_TEMP_DIR || DEFAULT_TEMP_ROOT);
    this.home = path.join(this.tempRoot, 'home');
    this.uploadRoot = path.join(this.tempRoot, 'uploads');
    this.taskRoot = path.join(this.tempRoot, 'tasks');
    this.python = path.resolve(options.python || process.env.KNOWLEDGE_SPEECH_PYTHON || DEFAULT_PYTHON);
    this.inspectScript = path.resolve(options.inspectScript || process.env.KNOWLEDGE_VIDEO_INSPECT_SCRIPT || DEFAULT_INSPECT_SCRIPT);
    this.transcribeScript = path.resolve(options.transcribeScript || process.env.KNOWLEDGE_VIDEO_TRANSCRIBE_SCRIPT || DEFAULT_TRANSCRIBE_SCRIPT);
    this.ytdlp = path.resolve(options.ytdlp || process.env.KNOWLEDGE_VIDEO_YTDLP || DEFAULT_YTDLP);
    this.ffmpeg = path.resolve(options.ffmpeg || process.env.KNOWLEDGE_VIDEO_FFMPEG || DEFAULT_FFMPEG);
    this.speechModel = String(options.speechModel || process.env.KNOWLEDGE_SPEECH_MODEL || 'small');
    this.maxUploadBytes = positiveInteger(options.maxUploadBytes || process.env.KNOWLEDGE_VIDEO_MAX_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
    this.maxDurationSeconds = positiveInteger(options.maxDurationSeconds || process.env.KNOWLEDGE_VIDEO_MAX_DURATION_SECONDS, DEFAULT_MAX_DURATION_SECONDS);
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS);
    this.ready = this.initialize();
  }

  runProcess(command, args, options = {}) {
    return runProcess(command, args, { ...options, home: this.home });
  }

  async initialize() {
    await Promise.all([
      fsp.mkdir(this.uploadRoot, { recursive: true, mode: 0o700 }),
      fsp.mkdir(this.taskRoot, { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(this.home, 'cache'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(this.home, 'config'), { recursive: true, mode: 0o700 }),
    ]);
    await this.cleanupStale();
    return this;
  }

  async status() {
    await this.ready;
    const [python, inspect, transcribe, ffmpeg, ytdlp] = await Promise.all([
      canExecute(this.python), canExecute(this.inspectScript), canExecute(this.transcribeScript),
      canExecute(this.ffmpeg), canExecute(this.ytdlp),
    ]);
    return {
      available: python && inspect && transcribe && ffmpeg,
      uploadAvailable: python && inspect && transcribe && ffmpeg,
      linkAvailable: python && inspect && transcribe && ffmpeg && ytdlp,
      maxUploadBytes: this.maxUploadBytes,
      maxDurationSeconds: this.maxDurationSeconds,
      acceptedTypes: [...VIDEO_MEDIA_TYPES],
      acceptedExtensions: [...VIDEO_EXTENSIONS.keys()],
      rawVideoRetention: 'task-only',
    };
  }

  validateInput(value) {
    const source = value && typeof value === 'object' ? value : {};
    const uploadId = String(source.uploadId || '');
    const url = String(source.url || '').trim();
    if (uploadId && url) throw videoError(400, '视频上传和链接只能选择一种。', 'MULTIPLE_VIDEO_SOURCES');
    if (uploadId) {
      if (!/^[a-f0-9-]{36}$/i.test(uploadId)) throw videoError(400, '视频上传标识不正确。', 'INVALID_VIDEO_UPLOAD');
      return { type: 'upload', uploadId };
    }
    if (url) return { type: 'url', url };
    throw videoError(400, '请上传视频或填写视频链接。', 'VIDEO_SOURCE_REQUIRED');
  }

  async storeUpload(userId, req, input = {}) {
    await this.ready;
    const media = supportedMedia(input.name, input.type || req.headers?.['content-type']);
    if (!media) throw videoError(415, '支持 MP4、MOV、WebM、MKV、AVI、FLV、WMV 和 M4V 视频。', 'UNSUPPORTED_VIDEO_TYPE');
    const announced = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(announced) && announced > this.maxUploadBytes) {
      throw videoError(413, '视频超过 1 GB 上传限制。', 'VIDEO_TOO_LARGE');
    }
    const id = crypto.randomUUID();
    const directory = path.join(this.uploadRoot, id);
    const fileName = `source${media.extension}`;
    const target = path.join(directory, fileName);
    await fsp.mkdir(directory, { mode: 0o700 });
    const handle = await fsp.open(target, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > this.maxUploadBytes) throw videoError(413, '视频超过 1 GB 上传限制。', 'VIDEO_TOO_LARGE');
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (!bytes) throw videoError(400, '上传的视频为空。', 'EMPTY_VIDEO_UPLOAD');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    const metadata = {
      version: 1,
      id,
      userId,
      name: safeName(input.name, fileName),
      type: media.mediaType,
      extension: media.extension,
      fileName,
      bytes,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(directory, 'upload.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { id, name: metadata.name, type: metadata.type, bytes, expiresInMs: this.retentionMs };
  }

  async deleteUpload(userId, id) {
    if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) throw videoError(404, '视频上传不存在。', 'VIDEO_UPLOAD_NOT_FOUND');
    const directory = path.join(this.uploadRoot, id);
    const metadata = await this.readUpload(directory, userId);
    await fsp.rm(directory, { recursive: true, force: true });
    return { ok: true, id: metadata.id };
  }

  async readUpload(directory, userId) {
    let metadata;
    try { metadata = JSON.parse(await fsp.readFile(path.join(directory, 'upload.json'), 'utf8')); }
    catch { throw videoError(404, '视频上传不存在或已经过期。', 'VIDEO_UPLOAD_NOT_FOUND'); }
    if (metadata.userId !== userId || !/^[a-f0-9-]{36}$/i.test(String(metadata.id || ''))) {
      throw videoError(404, '视频上传不存在。', 'VIDEO_UPLOAD_NOT_FOUND');
    }
    const source = path.join(directory, String(metadata.fileName || ''));
    if (!isInside(directory, source)) throw videoError(400, '视频上传记录已损坏。', 'INVALID_VIDEO_UPLOAD');
    const stat = await fsp.lstat(source).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw videoError(404, '视频上传不存在。', 'VIDEO_UPLOAD_NOT_FOUND');
    return { ...metadata, source };
  }

  async claimUpload(userId, uploadId, taskId) {
    const sourceDirectory = path.join(this.uploadRoot, uploadId);
    const metadata = await this.readUpload(sourceDirectory, userId);
    const taskDirectory = path.join(this.taskRoot, taskId);
    await fsp.rename(sourceDirectory, taskDirectory).catch((error) => {
      if (error.code === 'ENOENT') throw videoError(404, '视频上传不存在或已经使用。', 'VIDEO_UPLOAD_NOT_FOUND');
      throw error;
    });
    return {
      directory: taskDirectory,
      source: path.join(taskDirectory, metadata.fileName),
      name: metadata.name,
      mediaType: metadata.type,
      sourceUrl: '',
    };
  }

  async safeDirectDownload(initialUrl, directory, signal) {
    let url = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      url = await validatePublicUrl(url.toString());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30 * 60_000);
      timer.unref();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw videoError(422, '视频链接重定向不完整。', 'VIDEO_DOWNLOAD_FAILED');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok || !response.body) throw videoError(422, `视频下载失败（HTTP ${response.status}）。`, 'VIDEO_DOWNLOAD_FAILED');
        const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const extension = path.extname(url.pathname).toLowerCase();
        const media = supportedMedia(`video${extension}`, type);
        if (!media || (!type.startsWith('video/') && type !== 'application/octet-stream')) {
          throw videoError(415, '这个链接不是可直接下载的视频文件。', 'VIDEO_URL_NOT_DIRECT');
        }
        const announced = Number(response.headers.get('content-length') || 0);
        if (announced > this.maxUploadBytes) throw videoError(413, '链接视频超过 1 GB 限制。', 'VIDEO_TOO_LARGE');
        const target = path.join(directory, `source${media.extension}`);
        const handle = await fsp.open(target, 'wx', 0o600);
        let bytes = 0;
        try {
          for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > this.maxUploadBytes) throw videoError(413, '链接视频超过 1 GB 限制。', 'VIDEO_TOO_LARGE');
            await handle.write(chunk);
          }
        } catch (error) {
          await handle.close().catch(() => {});
          await fsp.rm(target, { force: true }).catch(() => {});
          throw error;
        }
        await handle.close();
        return {
          source: target,
          name: safeName(decodeURIComponent(path.basename(url.pathname) || '网络视频.mp4')),
          mediaType: media.mediaType,
          sourceUrl: initialUrl.toString(),
        };
      } catch (error) {
        if (signal?.aborted) throw videoError(499, '视频处理已取消。', 'VIDEO_CANCELLED');
        if (error?.name === 'AbortError') throw videoError(504, '视频下载超时。', 'VIDEO_DOWNLOAD_TIMEOUT');
        if (error?.status) throw error;
        throw videoError(422, `无法下载视频链接：${error.message}`, 'VIDEO_DOWNLOAD_FAILED');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw videoError(422, '视频链接重定向次数过多。', 'VIDEO_REDIRECT_LIMIT');
  }

  async platformDownload(url, directory, signal) {
    const output = path.join(directory, 'source.%(ext)s');
    const { stdout } = await this.runProcess(this.ytdlp, [
      '--no-config', '--no-playlist', '--no-cache-dir', '--no-part',
      '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2',
      '--max-filesize', String(this.maxUploadBytes), '--merge-output-format', 'mp4',
      '--ffmpeg-location', this.ffmpeg,
      '--print', 'before_dl:%(title)s',
      '--output', output,
      url.toString(),
    ], { cwd: directory, signal, timeoutMs: 30 * 60_000, outputLimit: 20_000 });
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const file = entries.find((entry) => entry.isFile() && /^source\.[a-z0-9]+$/i.test(entry.name));
    if (!file) throw videoError(422, '没有从分享链接获取到视频，请改为上传本地视频。', 'VIDEO_EXTRACT_FAILED');
    const source = path.join(directory, file.name);
    const stat = await fsp.stat(source);
    if (!stat.size || stat.size > this.maxUploadBytes) throw videoError(413, '链接视频为空或超过 1 GB 限制。', 'VIDEO_TOO_LARGE');
    const media = supportedMedia(file.name, 'video/mp4') || { mediaType: 'video/mp4' };
    const title = stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) || `${url.hostname} 视频`;
    return { source, name: safeName(`${title}${path.extname(file.name)}`), mediaType: media.mediaType, sourceUrl: url.toString() };
  }

  async acquireUrl(value, taskId, signal) {
    const url = await validatePublicUrl(value);
    const taskDirectory = path.join(this.taskRoot, taskId);
    await fsp.mkdir(taskDirectory, { mode: 0o700 });
    const direct = VIDEO_EXTENSIONS.has(path.extname(url.pathname).toLowerCase());
    if (!direct && !isPlatformUrl(url)) {
      throw videoError(415, '当前链接不是视频直链；分享链接暂支持 YouTube、Bilibili、小红书、抖音和 Vimeo。', 'UNSUPPORTED_VIDEO_SITE');
    }
    const acquired = direct
      ? await this.safeDirectDownload(url, taskDirectory, signal)
      : await this.platformDownload(url, taskDirectory, signal);
    return { directory: taskDirectory, ...acquired };
  }

  async inspect(source, signal) {
    const { stdout } = await this.runProcess(this.python, [this.inspectScript, source], {
      cwd: path.dirname(source), signal, timeoutMs: 2 * 60_000, outputLimit: 40_000,
    });
    try { return JSON.parse(stdout); }
    catch { throw videoError(422, '视频元数据无法解析。', 'VIDEO_METADATA_INVALID'); }
  }

  frameCount(durationSeconds) {
    if (durationSeconds <= 60) return Math.max(4, Math.min(12, Math.ceil(durationSeconds / 5)));
    if (durationSeconds <= 10 * 60) return 18;
    return 24;
  }

  async extractFrames(source, directory, durationSeconds, signal) {
    const framesDirectory = path.join(directory, 'frames');
    await fsp.mkdir(framesDirectory, { mode: 0o700 });
    const desired = this.frameCount(durationSeconds);
    const fps = Math.max(0.001, desired / Math.max(1, durationSeconds));
    await this.runProcess(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source,
      '-vf', `fps=${fps.toFixed(8)},scale=960:-2:force_original_aspect_ratio=decrease`,
      '-frames:v', String(desired), '-q:v', '6', path.join(framesDirectory, 'frame-%03d.jpg'),
    ], { cwd: directory, signal, timeoutMs: 30 * 60_000, errorLimit: 20_000 });
    const names = (await fsp.readdir(framesDirectory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    if (!names.length) throw videoError(422, '没有从视频中提取到画面。', 'VIDEO_FRAMES_EMPTY');
    const frames = [];
    for (const [index, name] of names.entries()) {
      const buffer = await fsp.readFile(path.join(framesDirectory, name));
      const timeSeconds = Math.min(durationSeconds, index * durationSeconds / Math.max(1, names.length));
      frames.push({
        name: `关键帧-${timestamp(timeSeconds).replaceAll(':', '-')}.jpg`,
        type: 'image/jpeg', kind: 'image', bytes: buffer.length, buffer,
        data: buffer.toString('base64'), timeSeconds, timestamp: timestamp(timeSeconds),
      });
    }
    return frames;
  }

  async transcribe(source, directory, signal) {
    const output = path.join(directory, 'transcript.json');
    await this.runProcess(this.python, [
      this.transcribeScript, source, '--output', output, '--model', this.speechModel, '--language', 'auto',
    ], { cwd: directory, signal, timeoutMs: 4 * 60 * 60_000, errorLimit: 20_000 });
    const payload = JSON.parse(await fsp.readFile(output, 'utf8'));
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    let transcript = '';
    for (const segment of segments) {
      const line = `[${timestamp(segment.start)}] ${String(segment.text || '').trim()}\n`;
      if (transcript.length + line.length > MAX_TRANSCRIPT_CHARACTERS) {
        transcript += '\n（转写内容过长，后续部分已截断）\n';
        break;
      }
      transcript += line;
    }
    return { ...payload, transcript: transcript.trim() };
  }

  async prepare({ userId, taskId, input, signal, onProgress = () => {} }) {
    await this.ready;
    const sourceInput = this.validateInput(input);
    onProgress({ title: sourceInput.type === 'upload' ? '正在接收上传视频' : '正在获取视频链接', message: '原视频只在服务器临时目录中处理。' });
    let acquired;
    try {
      acquired = sourceInput.type === 'upload'
        ? await this.claimUpload(userId, sourceInput.uploadId, taskId)
        : await this.acquireUrl(sourceInput.url, taskId, signal);
      onProgress({ title: '正在检查视频', message: '正在读取时长、分辨率和音视频轨道。' });
      const metadata = await this.inspect(acquired.source, signal);
      const durationSeconds = Number(metadata.durationSeconds || 0);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 2) {
        throw videoError(422, '视频时长不足 2 秒或无法识别。', 'VIDEO_DURATION_INVALID');
      }
      if (durationSeconds > this.maxDurationSeconds) {
        throw videoError(413, '第一版最多处理 2 小时的视频。', 'VIDEO_TOO_LONG');
      }
      onProgress({ title: '正在理解视频', message: metadata.audio ? '正在并行提取关键画面并转写音轨。' : '视频没有音轨，正在提取关键画面。' });
      const framesPromise = this.extractFrames(acquired.source, acquired.directory, durationSeconds, signal);
      const transcriptPromise = metadata.audio
        ? this.transcribe(acquired.source, acquired.directory, signal)
        : Promise.resolve({ language: '', segments: [], transcript: '' });
      const [framesResult, transcriptResult] = await Promise.allSettled([framesPromise, transcriptPromise]);
      if (framesResult.status === 'rejected') throw framesResult.reason;
      const transcript = transcriptResult.status === 'fulfilled'
        ? transcriptResult.value
        : { language: '', segments: [], transcript: '', warning: transcriptResult.reason?.message || '音轨转写失败。' };
      if (transcript.warning) onProgress({ title: '音轨转写未完成', message: `${transcript.warning} 将继续依据画面整理。`, warning: true });
      const frames = framesResult.value;
      const persistentIndexes = new Set([0, Math.floor((frames.length - 1) / 2), frames.length - 1]);
      const persistentFrames = frames.filter((_, index) => persistentIndexes.has(index)).map((frame) => ({
        name: frame.name, type: frame.type, kind: frame.kind, buffer: frame.buffer,
      }));
      return {
        ...acquired,
        metadata,
        durationSeconds,
        durationLabel: timestamp(durationSeconds),
        frames,
        persistentFrames,
        transcript,
        async cleanup() { await fsp.rm(acquired.directory, { recursive: true, force: true }); },
      };
    } catch (error) {
      if (acquired?.directory) await fsp.rm(acquired.directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async cleanupStale() {
    const cutoff = Date.now() - this.retentionMs;
    for (const root of [this.uploadRoot, this.taskRoot]) {
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
        const target = path.join(root, entry.name);
        const stat = await fsp.stat(target).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

export const knowledgeVideoConstants = {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_DURATION_SECONDS,
  VIDEO_EXTENSIONS,
  PLATFORM_HOSTS,
  validatePublicUrl,
  isPrivateIp,
  timestamp,
};
