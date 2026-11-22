#!/usr/bin/env python3
"""Transcribe one temporary audio file without retaining audio or transcript."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from faster_whisper import WhisperModel
from media_model import prepare_model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    model = WhisperModel(prepare_model(args.model), device="cpu", compute_type="int8")
    print("SECOND_MIND_MODEL_READY", file=sys.stderr, flush=True)
    segments, _ = model.transcribe(
        args.audio_file,
        language=args.language,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    text = "".join(segment.text for segment in segments).strip()
    if not text:
        print("没有识别到清晰语音。", file=sys.stderr)
        return 2
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
