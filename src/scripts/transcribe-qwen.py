#!/usr/bin/env python3
"""Offline Qwen3 ASR for microphone input and timestamped video notes."""
import argparse
import collections
import contextlib
import json
import os
from pathlib import Path
import re
import sys

import av
import numpy as np
import torch
from qwen_asr import Qwen3ASRModel


RATE = 16000
WINDOW = 30 * RATE


def audio_chunks(source):
    """Decode bounded windows, cutting near a quiet point in the last five seconds."""
    with av.open(source) as container:
        if not container.streams.audio:
            raise ValueError("文件中没有音轨。")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=RATE)
        pieces = []
        samples = 0
        offset = 0
        stream = container.streams.audio[0]
        # Align offsets to the media time origin for videos with a delayed audio track.
        delay = max(0.0, float((stream.start_time or 0) * stream.time_base)
                    - float(container.start_time or 0) / av.time_base)
        def frames():
            for frame in container.decode(stream):
                yield from resampler.resample(frame)
            yield from resampler.resample(None)
        for frame in frames():
            data = frame.to_ndarray().reshape(-1)
            pieces.append(data)
            samples += len(data)
            if samples < WINDOW:
                continue
            buf = np.concatenate(pieces)
            tail = buf[WINDOW - 5 * RATE:WINDOW].reshape(-1, 320)
            quiet = int(np.square(tail).mean(axis=1).argmin())
            cut = WINDOW - 5 * RATE + quiet * 320 + 160
            yield delay + offset / RATE, buf[:cut]
            offset += cut
            pieces = [buf[cut:]]
            samples = len(pieces[0])
        if samples:
            yield delay + offset / RATE, np.concatenate(pieces)


def aligned_segments(result, offset, duration):
    text = result.text.strip()
    words = getattr(result.time_stamps, 'items', []) or []
    fallback = [{'start': round(offset, 3), 'end': round(offset + duration, 3), 'text': text}]
    if not words:
        return fallback
    # Keep the ASR's punctuation and spacing while taking times from the aligner.
    positions = []
    cursor = 0
    for word in words:
        pos = text.find(word.text, cursor)
        if pos < 0 or not word.text:
            return fallback
        positions.append(pos)
        cursor = pos + len(word.text)
    segments = []
    first = 0
    for i, word in enumerate(words):
        last = i + 1 == len(words)
        end = len(text) if last else positions[i + 1]
        if last or re.search(r'[。！？.!?]', text[positions[i]:end]) or word.end_time - words[first].start_time > 12:
            start = 0 if first == 0 else positions[first]
            segments.append({'start': round(offset + words[first].start_time, 3),
                             'end': round(offset + min(duration, word.end_time), 3),
                             'text': text[start:end].strip()})
            first = i + 1
    return segments


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--language', choices=('auto', 'zh'), default='auto')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError('本地 Qwen3-ASR 无法访问 CUDA 显卡。')
    kwargs = dict(dtype=torch.bfloat16, device_map='cuda:0')
    aligner = {}
    if args.output:
        aligner_dir = Path(os.environ.get('KNOWLEDGE_ASR_ALIGNER_DIR', args.model.parent / 'Qwen3-ForcedAligner-0.6B'))
        aligner = dict(forced_aligner=str(aligner_dir.resolve()), forced_aligner_kwargs=kwargs)
    segments = []
    languages = collections.Counter()
    with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
        model = Qwen3ASRModel.from_pretrained(str(args.model.resolve()), **kwargs, **aligner,
                                             max_inference_batch_size=1, max_new_tokens=1024)
        for offset, waveform in audio_chunks(args.source):
            if not np.any(np.abs(waveform) > 0.0001):
                continue
            result = model.transcribe(audio=(waveform, RATE), language='Chinese' if args.language == 'zh' else None,
                                      return_time_stamps=bool(args.output))[0]
            if result.text.strip():
                segments.extend(aligned_segments(result, offset, len(waveform) / RATE))
                languages[result.language] += len(waveform)
    if not segments:
        raise ValueError('没有识别到清晰语音。')
    if args.output:
        tmp = args.output.with_suffix(f'.{os.getpid()}.tmp')
        tmp.write_text(json.dumps({'language': languages.most_common(1)[0][0], 'segments': segments},
                                  ensure_ascii=False), encoding='utf8')
        tmp.replace(args.output)
    else:
        print(' '.join(segment['text'] for segment in segments).strip())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'本地语音转写失败：{error}', file=sys.stderr)
        sys.exit(2)
