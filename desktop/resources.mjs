import fs from 'node:fs';
import path from 'node:path';

export function resolveDesktopResources({ appRoot, resourcesPath = appRoot, packaged = false } = {}) {
  if (!appRoot) throw new Error('Desktop appRoot is required');
  const backendRoot = packaged ? path.join(resourcesPath, 'backend') : appRoot;
  const runtimeRoot = packaged ? path.join(resourcesPath, 'runtime') : path.join(appRoot, 'build', 'runtime', 'win-x64');
  const windows = process.platform === 'win32';
  const linuxBin = packaged && !windows ? path.join(runtimeRoot, 'bin') : '';
  const developmentNode = path.join(appRoot, '.local', 'toolchain', 'node_modules', 'node', 'bin', 'node');
  return {
    appRoot: backendRoot,
    runtimeRoot,
    node: windows ? path.join(runtimeRoot, 'node', 'node.exe') : linuxBin ? path.join(linuxBin, 'node') : process.env.SECOND_MIND_NODE || (fs.existsSync(developmentNode) ? developmentNode : 'node'),
    python: windows ? path.join(runtimeRoot, 'python', 'python.exe') : linuxBin ? path.join(linuxBin, 'python') : process.env.KNOWLEDGE_SPEECH_PYTHON || '/usr/bin/python3',
    ffmpeg: windows ? path.join(runtimeRoot, 'ffmpeg', 'bin', 'ffmpeg.exe') : linuxBin ? path.join(linuxBin, 'ffmpeg') : process.env.KNOWLEDGE_VIDEO_FFMPEG || '/usr/bin/ffmpeg',
    ffprobe: windows ? path.join(runtimeRoot, 'ffmpeg', 'bin', 'ffprobe.exe') : linuxBin ? path.join(linuxBin, 'ffprobe') : '/usr/bin/ffprobe',
    ytdlp: windows ? path.join(runtimeRoot, 'python', 'python.exe') : linuxBin ? path.join(linuxBin, 'python') : process.env.KNOWLEDGE_SPEECH_PYTHON || '/usr/bin/python3',
    platformHelper: path.join(backendRoot, 'platform', 'native', 'SecondMind.Platform.exe'),
  };
}

export function runtimeEnvironment({ resources, stateRoot }) {
  const paths = [path.dirname(resources.node), path.dirname(resources.python), path.dirname(resources.ffmpeg)];
  const currentPath = process.env.PATH || process.env.Path || '';
  return {
    KNOWLEDGE_SPEECH_PYTHON: resources.python,
    SECOND_MIND_PLATFORM_HELPER: resources.platformHelper,
    KNOWLEDGE_VIDEO_YTDLP: resources.ytdlp,
    KNOWLEDGE_VIDEO_YTDLP_MODULE: '1',
    KNOWLEDGE_VIDEO_FFMPEG: resources.ffmpeg,
    KNOWLEDGE_SPEECH_MODEL: 'small',
    KNOWLEDGE_SPEECH_MODEL_DIR: path.join(stateRoot, 'models', 'faster-whisper-small'),
    KNOWLEDGE_MEDIA_MODEL_STATUS: path.join(stateRoot, 'models', 'status.json'),
    KNOWLEDGE_MEDIA_RUNTIME: '1',
    HF_HOME: path.join(stateRoot, 'models', 'hub'),
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    CUDA_VISIBLE_DEVICES: '',
    PATH: [...paths, currentPath].join(path.delimiter),
  };
}

export function assertPackagedResources(resources) {
  const required = ['node', 'python', 'ffmpeg', 'ffprobe'];
  if (process.platform === 'win32') required.push('platformHelper');
  for (const key of required) {
    if (!fs.existsSync(resources[key])) throw new Error(`安装包缺少运行组件：${key}`);
    if (resources[key].split(/[\\/]/).includes('app.asar')) throw new Error(`运行组件不能位于 ASAR：${key}`);
  }
}
