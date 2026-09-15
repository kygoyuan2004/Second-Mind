#!/usr/bin/env python3
"""Transcribe a video locally and retain sentence timestamps in a JSON file."""

import argparse
import json
import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_file")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            args.video_file,
            language=None if args.language == "auto" else args.language,
            beam_size=3,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        collected = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            collected.append({
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
            })
        if not collected:
            print("视频中没有识别到清晰语音。", file=sys.stderr)
            return 3
        payload = {
            "language": getattr(info, "language", "") or "",
            "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
            "segments": collected,
        }
        temporary = f"{args.output}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(temporary, args.output)
        return 0
    except Exception as error:
        print(f"视频语音转写失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
