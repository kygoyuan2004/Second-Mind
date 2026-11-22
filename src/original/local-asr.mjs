import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configuredQwenAsr() {
  const python = process.env.KNOWLEDGE_ASR_PYTHON;
  const model = process.env.KNOWLEDGE_ASR_MODEL_DIR;
  if (!python && !model) return null;
  if (!python || !model || !path.isAbsolute(python) || !path.isAbsolute(model)) {
    throw new Error('Qwen ASR 需要设置解释器和模型目录的绝对路径。');
  }
  return { python, model, script: fileURLToPath(new URL('../scripts/transcribe-qwen.py', import.meta.url)),
    env: { CUDA_VISIBLE_DEVICES: process.env.KNOWLEDGE_ASR_GPU ?? '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      ...(process.env.KNOWLEDGE_ASR_ALIGNER_DIR ? { KNOWLEDGE_ASR_ALIGNER_DIR: process.env.KNOWLEDGE_ASR_ALIGNER_DIR } : {}) } };
}
