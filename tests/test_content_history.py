import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import content_history as history


class ContentHistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name in ("TRANSCRIPTS_DIR", "SUMMARIES_DIR", "SCENES_DIR"):
            path = root / name
            path.mkdir()
            patch = mock.patch.object(history, name, path)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(history, "HISTORY_DB", root / "history.sqlite3")
        patch.start()
        self.addCleanup(patch.stop)
        history._busy.clear()
        self.addCleanup(history._busy.clear)
        self.transcript = history.TRANSCRIPTS_DIR / "video_whisper.json"
        self.transcript.write_bytes(b'\xef\xbb\xbf[\r\n{"text":"Before"}\r\n]')

    def change(self, path, content, video="video"):
        before = history.capture(video)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        history.record(video, "Saved edit", before)

    def test_persistent_undo_redo_restores_exact_bytes_and_clears_redo_on_new_edit(self):
        original = self.transcript.read_bytes()
        self.change(self.transcript, b'[{"text":"After"}]')
        history.restore("video", "undo")
        self.assertEqual(self.transcript.read_bytes(), original)
        self.assertEqual(history.status("video")["redo"], "Saved edit")
        history.restore("video", "redo")
        self.assertEqual(self.transcript.read_bytes(), b'[{"text":"After"}]')
        history.restore("video", "undo")
        self.change(self.transcript, b'[{"text":"Different"}]')
        self.assertIsNone(history.status("video")["redo"])
        with self.assertRaisesRegex(ValueError, "Nothing to redo"):
            history.restore("video", "redo")

    def test_multiple_files_versions_and_new_files_restore_together(self):
        original = history.capture("video")
        summary = history.SUMMARIES_DIR / "video.json"
        version = history.TRANSCRIPTS_DIR / "versions" / "video" / "saved.json"
        version.parent.mkdir(parents=True)
        version.write_text("{}", encoding="utf-8")
        summary.write_text("[]", encoding="utf-8")
        self.transcript.write_text("[]", encoding="utf-8")
        history.record("video", "Generation", original)
        history.restore("video", "undo")
        self.assertEqual(history.capture("video"), original)
        self.assertFalse(summary.exists())
        self.assertFalse(version.exists())
        history.restore("video", "redo")
        self.assertTrue(summary.exists())
        self.assertTrue(version.exists())

    def test_external_edits_conflict_without_partial_restore(self):
        before = history.capture("video")
        summary = history.SUMMARIES_DIR / "video.json"
        summary.write_bytes(b"[]")
        self.transcript.write_bytes(b"[]")
        history.record("video", "Edit", before)
        self.transcript.write_bytes(b'[{"text":"External"}]')
        with self.assertRaisesRegex(ValueError, "changed outside"):
            history.restore("video", "undo")
        self.assertEqual(summary.read_bytes(), b"[]")
        self.assertEqual(self.transcript.read_bytes(), b'[{"text":"External"}]')

    def test_restore_rolls_back_other_files_after_write_failure(self):
        before = history.capture("video")
        self.transcript.write_bytes(b"[]")
        summary = history.SUMMARIES_DIR / "video.json"
        summary.write_bytes(b"[]")
        history.record("video", "Edit", before)
        expected = history.capture("video")
        write = history._write
        calls = 0

        def fail_once(path, content):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Disk write failed")
            return write(path, content)

        with mock.patch.object(history, "_write", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "Disk write failed"):
                history.restore("video", "undo")
        self.assertEqual(history.capture("video"), expected)
        self.assertEqual(history.status("video")["undo"], "Edit")

    def test_video_isolation_and_worker_progress_guard(self):
        self.change(self.transcript, b"[]")
        other = history.TRANSCRIPTS_DIR / "video-other_whisper.json"
        other.write_bytes(b"[]")
        self.assertIsNone(history.status("video-other")["undo"])
        progress = history.TRANSCRIPTS_DIR / "video_whisper_progress.txt"
        progress.write_text("0", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Finish or stop"):
            history.restore("video", "undo")
        progress.unlink()
        history.restore("video", "undo")
        self.assertEqual(other.read_bytes(), b"[]")

    def test_http_middleware_records_save_and_rejects_overlap(self):
        app = FastAPI()
        app.include_router(history.router)
        app.add_middleware(history.ContentHistoryMiddleware)

        @app.post("/outline_item/video")
        async def edit():
            self.transcript.write_bytes(b"[]")
            return {"success": True}

        with TestClient(app) as client:
            self.assertEqual(client.post("/outline_item/video").status_code, 200)
            self.assertEqual(client.get("/content_history/video").json()["undo"], "Edit chapter or section")
            self.assertEqual(client.post("/content_history/video/undo").status_code, 200)
            self.assertEqual(client.post("/content_history/video/redo").status_code, 200)
            history._busy.add("video")
            self.assertEqual(client.post("/outline_item/video").status_code, 409)
            history._busy.clear()

    def test_view_returns_restored_source_after_undo_removes_a_translation(self):
        (history.TRANSCRIPTS_DIR / "video_active_source.json").write_text(
            '{"kind":"transcript","source":"whisper"}', encoding="utf-8")
        content = history.view("video", language="de", chapter_language="de")
        self.assertEqual(content["transcript"][0]["text"], "Before")
        self.assertEqual(content["transcript_language"], "")
        self.assertEqual(content["source"], "whisper")
        self.assertEqual(content["chapter_language"], "")


if __name__ == "__main__":
    unittest.main()
