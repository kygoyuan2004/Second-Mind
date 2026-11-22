"""No-network tests of first-use download, resume, checksum errors and retry."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("media_model", ROOT / "src/scripts/media_model.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class Response(io.BytesIO):
    def __init__(self, payload, status=200):
        super().__init__(payload)
        self.status = status


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "model"
        self.directory.mkdir()
        self.status = self.root / "status.json"
        self.payload = b"fixed model contents"
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"files": [{"name": "model.bin", "size": len(self.payload),
            "sha256": hashlib.sha256(self.payload).hexdigest()}]}))
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(media, "MANIFEST", manifest))
        stack.enter_context(patch.dict(os.environ, {"KNOWLEDGE_MEDIA_RUNTIME": "1", "KNOWLEDGE_SPEECH_MODEL_DIR": str(self.directory), "KNOWLEDGE_MEDIA_MODEL_STATUS": str(self.status)}))
        stack.enter_context(patch.dict("sys.modules", {
            "filelock": types.SimpleNamespace(FileLock=lambda *args, **kwargs: contextlib.nullcontext()),
            "certifi": types.SimpleNamespace(where=lambda: None),
        }))
        stack.enter_context(patch.object(media.time, "sleep"))

    def test_download_resume_and_offline_reuse(self):
        (self.directory / "model.bin.partial").write_bytes(self.payload[:5])
        def fetch(request, **kwargs):
            self.assertEqual(request.get_header("Range"), "bytes=5-")
            return Response(self.payload[5:], 206)
        with patch.object(media.urllib.request, "urlopen", fetch):
            self.assertEqual(media.prepare_model(), str(self.directory))
        self.assertEqual((self.directory / "model.bin").read_bytes(), self.payload)
        self.assertEqual(json.loads(self.status.read_text())["state"], "ready")
        with patch.object(media.urllib.request, "urlopen", side_effect=AssertionError("must work offline")):
            media.prepare_model()

    def test_checksum_failure_does_not_mark_ready_and_retry_recovers(self):
        with patch.object(media.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: Response(b"x" * len(self.payload))):
            with self.assertRaisesRegex(RuntimeError, "下载失败"):
                media.prepare_model()
        self.assertEqual(json.loads(self.status.read_text())["state"], "error")
        self.assertFalse((self.directory / ".complete.json").exists())
        with patch.object(media.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: Response(self.payload)):
            media.prepare_model()
        self.assertEqual(json.loads(self.status.read_text())["state"], "ready")

    def test_complete_partial_after_interruption_needs_no_http_request(self):
        (self.directory / "model.bin.partial").write_bytes(self.payload)
        with patch.object(media.urllib.request, "urlopen", side_effect=AssertionError("must resume complete partial")):
            media.prepare_model()
        self.assertEqual(json.loads(self.status.read_text())["state"], "ready")


if __name__ == "__main__":
    unittest.main()
