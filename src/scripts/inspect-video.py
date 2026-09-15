#!/usr/bin/env python3
"""Inspect one video with PyAV and emit a small JSON metadata document."""

import argparse
import json
import sys

import av


def stream_duration(stream):
    if stream.duration is None or stream.time_base is None:
        return 0.0
    return max(0.0, float(stream.duration * stream.time_base))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_file")
    args = parser.parse_args()

    try:
        with av.open(args.video_file) as container:
            video = next(iter(container.streams.video), None)
            audio = next(iter(container.streams.audio), None)
            if video is None:
                print("文件中没有可识别的视频轨道。", file=sys.stderr)
                return 2
            duration = (
                float(container.duration / av.time_base)
                if container.duration is not None
                else max(stream_duration(video), stream_duration(audio) if audio else 0.0)
            )
            payload = {
                "durationSeconds": round(max(0.0, duration), 3),
                "format": container.format.name if container.format else "",
                "video": {
                    "codec": video.codec_context.name or "",
                    "width": int(video.codec_context.width or 0),
                    "height": int(video.codec_context.height or 0),
                    "averageRate": str(video.average_rate or ""),
                },
                "audio": None,
            }
            if audio is not None:
                payload["audio"] = {
                    "codec": audio.codec_context.name or "",
                    "channels": int(audio.codec_context.channels or 0),
                    "sampleRate": int(audio.codec_context.sample_rate or 0),
                }
            json.dump(payload, sys.stdout, ensure_ascii=False)
            return 0
    except Exception as error:
        print(f"无法读取视频：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
