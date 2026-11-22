#!/usr/bin/env python3
"""Assemble a Windows x64 runtime on Windows or Linux using only build-host Python.

Every upstream archive/wheel is pinned by SHA-256. No pip, Python, Git or Node
installation is needed by the installed application.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import struct
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def digest(target):
    value = hashlib.sha256()
    with target.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(entry, cache):
    filename = entry.get("filename") or entry["url"].rsplit("/", 1)[-1]
    destination = cache / filename
    if destination.exists() and digest(destination) == entry["sha256"]:
        return destination
    partial = destination.with_suffix(destination.suffix + ".partial")
    for attempt in range(3):
        try:
            print(f"Downloading {filename}", flush=True)
            with urllib.request.urlopen(entry["url"], timeout=60) as source, partial.open("wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            if digest(partial) != entry["sha256"]:
                raise ValueError(f"SHA-256 mismatch: {filename}")
            partial.replace(destination)
            return destination
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def safe_extract(archive, destination, strip_root=False):
    with zipfile.ZipFile(archive) as zipped:
        roots = {PurePosixPath(item.filename).parts[0] for item in zipped.infolist()}
        if strip_root and len(roots) != 1:
            raise ValueError(f"Unexpected archive roots: {archive}")
        for item in zipped.infolist():
            parts = PurePosixPath(item.filename).parts
            if any(part in ("..", "/") or ":" in part or "\\" in part for part in parts):
                raise ValueError(f"Unsafe archive path: {item.filename}")
            if ((item.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError("Runtime archives must not contain symbolic links")
            parts = parts[1:] if strip_root else parts
            if not parts:
                continue
            target = destination.joinpath(*parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(item) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)


def validate_pe(file):
    with file.open("rb") as source:
        if source.read(2) != b"MZ":
            raise ValueError(f"Invalid Windows executable: {file}")
        source.seek(0x3C)
        offset = struct.unpack("<I", source.read(4))[0]
        source.seek(offset)
        if source.read(4) != b"PE\x00\x00" or struct.unpack("<H", source.read(2))[0] != 0x8664:
            raise ValueError(f"Expected x64 executable: {file}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=ROOT / "build" / "runtime-cache")
    parser.add_argument("--output", type=Path, default=ROOT / "build" / "runtime" / "win-x64")
    args = parser.parse_args()
    lock = json.loads((ROOT / "scripts" / "windows-runtime-lock.json").read_text())
    args.cache.mkdir(parents=True, exist_ok=True)
    # Reuse the initial wheel resolution cache without downloading twice.
    for wheel in lock["wheels"]:
        source = args.cache / "wheels" / wheel["filename"]
        if source.exists() and not (args.cache / source.name).exists():
            shutil.copyfile(source, args.cache / source.name)
    entries = lock["archives"] + lock["wheels"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda entry: download(entry, args.cache), entries))
    staging = args.output.with_name(args.output.name + ".staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    for entry, archive in zip(lock["archives"], paths[:len(lock["archives"])]):
        safe_extract(archive, staging / entry["name"], entry["stripRoot"])
    site = staging / "python" / "Lib" / "site-packages"
    site.mkdir(parents=True)
    for archive in paths[len(lock["archives"]):]:
        safe_extract(archive, site)
    # Wheel .data directories follow the wheel installation scheme.
    for data in list(site.glob("*.data")):
        for kind in ("purelib", "platlib"):
            if (data / kind).is_dir():
                shutil.copytree(data / kind, site, dirs_exist_ok=True)
        if (data / "data").is_dir():
            shutil.copytree(data / "data", staging / "python", dirs_exist_ok=True)
        shutil.rmtree(data)
    # Embedded Python ignores PYTHONPATH; explicitly enable site-packages and sitecustomize.
    (staging / "python" / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="ascii")
    # Keep the signed Microsoft app-local CRT with Python, not a machine-wide installer.
    for dll in (staging / "vclibs").rglob("*.dll"):
        if dll.name.lower().startswith(("msvcp", "vcruntime", "concrt")):
            shutil.copyfile(dll, staging / "python" / dll.name)
    (site / "sitecustomize.py").write_text(
        "import os, sys\n"
        "_runtime_dll_path = os.add_dll_directory(os.path.dirname(sys.executable)) if hasattr(os, 'add_dll_directory') else None\n",
        encoding="utf-8")
    for filename in ("node/node.exe", "python/python.exe", "ffmpeg/bin/ffmpeg.exe", "ffmpeg/bin/ffprobe.exe"):
        validate_pe(staging / filename)
    if not (staging / "python" / "msvcp140.dll").is_file():
        raise ValueError("Missing bundled Microsoft C++ runtime")
    # Runtime hashes are independently verifiable after packaging.
    manifest = {"schemaVersion": 1, "platform": "win32-x64", "files": []}
    for file in sorted(staging.rglob("*")):
        if file.is_file():
            manifest["files"].append({"path": file.relative_to(staging).as_posix(), "size": file.stat().st_size, "sha256": digest(file)})
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.output.exists():
        shutil.rmtree(args.output)
    staging.replace(args.output)
    print(f"Prepared {args.output} ({len(manifest['files'])} verified files)", flush=True)


if __name__ == "__main__":
    main()
