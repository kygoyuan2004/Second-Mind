import { markPublicMessage } from '../public-errors.mjs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'transcribe-audio.py');
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 5 * 60_000;
const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000;
const AUDIO_TYPES = new Map([
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
  ['audio/mpeg', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/aac', '.aac'],
  ['audio/3gpp', '.3gp'],
]);

function transcriptionError(status, message, code = 'TRANSCRIPTION_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return markPublicMessage(error);
}

function cleanAudioType(value) {
  return String(value || '').toLowerCase().split(';')[0].trim();
}

function safeEnvironment(home) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  for (const key of Object.keys(env)) {
    if (/(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)/i.test(key)) {
      delete env[key];
    }
  }
  delete env.SSH_AUTH_SOCK;
  delete env.GPG_AGENT_INFO;
  return { ...env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'), CUDA_VISIBLE_DEVICES: '' };
}

async function canExecute(target) {
  try {
    await fsp.access(target, 1);
    return true;
  } catch {
    return false;
  }
}

export class KnowledgeTranscriber {
  constructor(options = {}) {
    this.python = path.resolve(
      options.python || process.env.KNOWLEDGE_SPEECH_PYTHON ||
        path.resolve(process.env.KNOWLEDGE_SPEECH_PYTHON || '/opt/media/bin/python'),
    );
    this.script = path.resolve(options.script || process.env.KNOWLEDGE_SPEECH_SCRIPT || DEFAULT_SCRIPT);
    this.model = String(options.model || process.env.KNOWLEDGE_SPEECH_MODEL || 'small');
    this.tempRoot = path.resolve(
      options.tempRoot || process.env.KNOWLEDGE_SPEECH_TEMP_DIR ||
        path.resolve(process.env.DATA_DIR || 'data', 'speech'),
    );
    this.home = path.join(this.tempRoot, 'home');
    this.runningUsers = new Set();
  }

  async status() {
    const [python, script] = await Promise.all([canExecute(this.python), canExecute(this.script)]);
    return {
      available: python && script,
      maxBytes: MAX_AUDIO_BYTES,
      maxDurationMs: MAX_AUDIO_DURATION_MS,
      privacy: 'server-temporary',
    };
  }

  async transcribe(userId, body = {}) {
    const availability = await this.status();
    if (!availability.available) {
      throw transcriptionError(503, '服务器语音转写尚未就绪，请使用手机键盘自带的听写。', 'SPEECH_UNAVAILABLE');
    }
    if (this.runningUsers.has(userId)) {
      throw transcriptionError(409, '已有一段录音正在转写，请稍候。', 'SPEECH_BUSY');
    }
    const mediaType = cleanAudioType(body.type);
    const extension = AUDIO_TYPES.get(mediaType);
    if (!extension) {
      throw transcriptionError(415, '手机生成的录音格式暂不支持。', 'UNSUPPORTED_AUDIO_TYPE');
    }
    const durationMs = Number(body.durationMs || 0);
    if (durationMs > MAX_AUDIO_DURATION_MS) {
      throw transcriptionError(413, '单次口述最长 5 分钟。', 'AUDIO_TOO_LONG');
    }
    const encoded = String(body.data || '').replace(/\s/g, '');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw transcriptionError(400, '录音数据不正确。', 'INVALID_AUDIO_DATA');
    }
    const audio = Buffer.from(encoded, 'base64');
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
      throw transcriptionError(413, '录音为空或超过 8 MB。', 'AUDIO_TOO_LARGE');
    }
    if (audio.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      throw transcriptionError(400, '录音数据不正确。', 'INVALID_AUDIO_DATA');
    }

    await fsp.mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.tempRoot, `${crypto.randomUUID()}${extension}`);
    this.runningUsers.add(userId);
    try {
      await fsp.writeFile(temporary, audio, { mode: 0o600, flag: 'wx' });
      const text = await this.run(temporary);
      return { text, durationMs: Number.isFinite(durationMs) ? durationMs : 0 };
    } finally {
      this.runningUsers.delete(userId);
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  run(audioFile) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script, audioFile, '--model', this.model, '--language', 'zh'], {
        cwd: this.tempRoot,
        env: safeEnvironment(this.home),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), TRANSCRIPTION_TIMEOUT_MS);
      timer.unref();
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 40_000) stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 8_000) stderr += String(chunk);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(transcriptionError(503, `语音转写服务无法启动：${error.message}`, 'SPEECH_START_FAILED'));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code === 0 && text) return resolve(text);
        if (signal === 'SIGKILL') {
          return reject(transcriptionError(504, '语音转写超时，请缩短口述后重试。', 'SPEECH_TIMEOUT'));
        }
        const detail = stderr.trim().split('\n').at(-1) || '没有识别到清晰语音。';
        return reject(transcriptionError(422, detail.slice(0, 500), 'SPEECH_NOT_RECOGNIZED'));
      });
    });
  }
}

export const knowledgeTranscriptionConstants = {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  AUDIO_TYPES,
};
