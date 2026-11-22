"""Download the pinned desktop speech model on explicit first use, with resumable progress."""

import hashlib
import json
import os
from pathlib import Path
import ssl
import sys
import time
import urllib.request

REPOSITORY = "Systran/faster-whisper-small"
REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MANIFEST = Path(__file__).with_name("media-model-lock.json")


def write_status(target, **values):
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {"model": "small", "revision": REVISION, "updatedAt": time.time(), **values}
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, target)


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_model(requested="small"):
    if os.environ.get("KNOWLEDGE_MEDIA_RUNTIME") != "1":
        return requested
    if requested != "small":
        raise ValueError("桌面版首版仅内置 small 语音模型配置。")
    from filelock import FileLock
    import certifi

    directory = Path(os.environ["KNOWLEDGE_SPEECH_MODEL_DIR"])
    status = Path(os.environ["KNOWLEDGE_MEDIA_MODEL_STATUS"])
    directory.mkdir(parents=True, exist_ok=True)
    files = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    total = sum(entry["size"] for entry in files)
    marker = directory / ".complete.json"
    with FileLock(str(directory / ".download.lock"), timeout=60 * 60):
        try:
            completed = json.loads(marker.read_text(encoding="utf-8"))
            if completed.get("revision") == REVISION and all(
                (directory / entry["name"]).stat().st_size == entry["size"] for entry in files
            ):
                write_status(status, state="ready", downloadedBytes=total, totalBytes=total)
                return str(directory)
        except (OSError, ValueError):
            pass
        downloaded = 0
        try:
            for entry in files:
                destination = directory / entry["name"]
                if destination.exists() and destination.stat().st_size == entry["size"] and sha256(destination) == entry["sha256"]:
                    downloaded += entry["size"]
                    continue
                partial = destination.with_name(destination.name + ".partial")
                url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{entry['name']}"
                for attempt in range(3):
                    offset = partial.stat().st_size if partial.exists() else 0
                    if offset > entry["size"]:
                        partial.unlink()
                        offset = 0
                    if offset == entry["size"]:
                        if sha256(partial) == entry["sha256"]:
                            os.replace(partial, destination)
                            break
                        partial.unlink()
                        offset = 0
                    write_status(status, state="downloading", file=entry["name"], downloadedBytes=downloaded + offset, totalBytes=total, attempt=attempt + 1)
                    try:
                        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
                        with urllib.request.urlopen(request, context=ssl.create_default_context(cafile=certifi.where()), timeout=45) as response:
                            if offset and response.status != 206:
                                offset = 0
                            last_update = 0
                            with partial.open("ab" if offset else "wb") as output:
                                while True:
                                    chunk = response.read(1024 * 1024)
                                    if not chunk:
                                        break
                                    output.write(chunk)
                                    offset += len(chunk)
                                    if offset > entry["size"]:
                                        raise ValueError("语音模型下载大小异常。")
                                    if time.monotonic() - last_update >= 0.25:
                                        write_status(status, state="downloading", file=entry["name"], downloadedBytes=downloaded + offset, totalBytes=total)
                                        last_update = time.monotonic()
                        if partial.stat().st_size != entry["size"] or sha256(partial) != entry["sha256"]:
                            partial.unlink(missing_ok=True)
                            raise ValueError("语音模型完整性校验失败。")
                        os.replace(partial, destination)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        time.sleep(attempt + 1)
                downloaded += entry["size"]
            marker.write_text(json.dumps({"revision": REVISION}), encoding="utf-8")
            write_status(status, state="ready", downloadedBytes=total, totalBytes=total)
            return str(directory)
        except Exception as error:
            write_status(status, state="error", downloadedBytes=downloaded, totalBytes=total,
                         message="语音模型下载失败，请检查网络后重试。")
            raise RuntimeError("语音模型下载失败，请检查网络后重试。") from error


if __name__ == "__main__":
    try:
        print(prepare_model())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
