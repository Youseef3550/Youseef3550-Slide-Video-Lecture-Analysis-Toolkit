import ast
import asyncio
import sys
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from export_jobs import ExportJobStore, cleanup_export_workspace, export_workspace
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient
from caption_exports import render_captioned_video, render_selectable_captions


class ExportJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = ExportJobStore(Path(self.directory.name))

    def wait_for_job(self, job_id):
        for _ in range(100):
            state = self.store.read(job_id)
            if state["status"] in {"complete", "error", "cancelled"}:
                return state
            time.sleep(0.02)
        self.fail("Export job did not finish")

    def test_cancel_stops_process_and_removes_workspace(self):
        started = threading.Event()
        details = {}

        async def generate(video_id, options, step, artifacts, workspace):
            details["workspace"] = workspace
            (workspace / "partial.mp4").write_bytes(b"unfinished")
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", "import time; time.sleep(60)")
            details["process"] = process
            started.set()
            try:
                await process.wait()
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()

        job_id = self.store.start("video", {}, generate)
        self.assertTrue(started.wait(5))
        self.store.cancel(job_id)
        self.store.cancel(job_id)
        state = self.wait_for_job(job_id)
        self.assertEqual(state["status"], "cancelled")
        self.assertIsNotNone(details["process"].returncode)
        self.assertFalse(details["workspace"].exists())
        self.assertNotIn("download_url", state)
        self.assertEqual(self.store.cancel(job_id)["status"], "cancelled")
        self.assertEqual(ExportJobStore(self.directory.name).read(job_id)["status"], "cancelled")

    def test_cancel_queued_job_does_not_start_generation(self):
        generated = threading.Event()
        cleaned = threading.Event()

        async def generate(*args):
            generated.set()

        with patch("export_jobs.threading.Thread.start", autospec=True) as start:
            job_id = self.store.start("video", {}, generate, on_finish=cleaned.set)
            thread = start.call_args.args[0]
            self.store.cancel(job_id)
        thread.start()
        self.assertEqual(self.wait_for_job(job_id)["status"], "cancelled")
        self.assertFalse(generated.is_set())
        self.assertTrue(cleaned.wait(5), "Queued cancellation must clean uploaded inputs too")

    def test_both_caption_encoders_kill_process_on_cancellation(self):
        create_process = asyncio.create_subprocess_exec
        for mode in ("burn", "tracks"):
            with self.subTest(mode=mode):
                started = threading.Event()
                details = {}

                async def encoder_process(*args, **kwargs):
                    process = await create_process(
                        sys.executable, "-c", "import time; time.sleep(60)",
                        stdout=asyncio.subprocess.PIPE)
                    details["process"] = process
                    started.set()
                    return process

                async def generate(video_id, options, step, artifacts, workspace):
                    details["workspace"] = workspace
                    captions = [{"start": 0, "duration": 1, "text": "Hello"}]
                    if mode == "burn":
                        return await render_captioned_video("source.mp4", captions, "copy", workspace, step)
                    tracks = [{"captions": captions, "label": "English", "language": "eng"}]
                    return await render_selectable_captions("source.mp4", tracks, "copy", workspace, step)

                with patch("caption_exports.video_duration", new=AsyncMock(return_value=60)), \
                        patch("caption_exports.asyncio.create_subprocess_exec", side_effect=encoder_process):
                    job_id = self.store.start("video", {}, generate)
                    self.assertTrue(started.wait(5))
                    self.store.cancel(job_id)
                    job = self.wait_for_job(job_id)
                self.assertEqual(job["status"], "cancelled", job)
                self.assertIsNotNone(details["process"].returncode)
                self.assertFalse(details["workspace"].exists())

    def test_locked_state_file_does_not_abort_export(self):
        async def generate(video_id, options, step, artifacts, workspace):
            step("Encoding a clip")
            download = workspace / "lecture.zip"
            download.write_bytes(b"archive")
            return SimpleNamespace(path=str(download))

        locked = PermissionError(5, "Access is denied")
        with patch.object(Path, "replace", side_effect=locked), patch("export_jobs._STATE_RETRY_DELAY", 0):
            job_id = self.store.start("video", {}, generate)
            state = self.wait_for_job(job_id)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["filename"], f"lecture_{datetime.fromtimestamp(state['created_at']):%Y-%m-%d}.zip")
        self.assertIn("Encoding a clip", [step["message"] for step in state["steps"]])

    def test_steps_and_html_survive_restart_with_isolated_download(self):
        async def generate(video_id, options, step, artifacts, workspace):
            step("Encoding a clip")
            html = workspace / "index.html"
            html.write_text("<h1>Saved lecture</h1>", encoding="utf-8")
            asset = workspace / "clip.mp4"
            asset.write_bytes(b"clip")
            artifacts(workspace, [html, asset], "Lecture")
            download = workspace / "lecture.zip"
            download.write_bytes(b"archive")
            return SimpleNamespace(path=download)
        job_id = self.store.start("video", {}, generate)
        state = self.wait_for_job(job_id)
        self.assertEqual(state["status"], "complete")
        with patch("export_jobs.time.time", return_value=state["finished_at"] + 60):
            self.assertEqual(self.store.read(job_id)["elapsed"], state["elapsed"])
        self.assertIn("Encoding a clip", [step["message"] for step in state["steps"]])
        restarted = ExportJobStore(Path(self.directory.name))
        self.assertEqual(restarted.list("video")[0]["open_url"], state["open_url"])
        self.assertEqual(restarted.file(job_id, "index.html", webpage=True).read_text(), "<h1>Saved lecture</h1>")
        self.assertEqual(restarted.file(job_id, state["download_file"]).read_bytes(), b"archive")
        with self.assertRaises(FileNotFoundError):
            restarted.file(job_id, "../state.json", webpage=True)
        with self.assertRaises(ValueError):
            restarted.read("../other")

    def test_dated_filename_is_not_suffixed_twice(self):
        async def generate(video_id, options, step, artifacts, workspace):
            output = workspace / "lecture_2026-10-19.mp4"
            output.write_bytes(b"video")
            return SimpleNamespace(path=output)
        job = self.wait_for_job(self.store.start("video", {}, generate))
        self.assertEqual(job["status"], "complete")
        self.assertEqual(job["filename"], "lecture_2026-10-19.mp4")

    def test_worker_errors_are_visible(self):
        async def generate(*args):
            raise RuntimeError("FFmpeg failed")
        state = self.wait_for_job(self.store.start("video", {}, generate))
        self.assertEqual(state["status"], "error")
        self.assertIn("FFmpeg failed", state["error"])

    def test_listing_all_videos_preserves_per_video_filter_and_restart_history(self):
        for index, video in enumerate(("first", "second")):
            self.store._write(f"{index:032x}", {
                "video_id": video, "status": "complete", "title": f"Captioned video - {video}",
                "created_at": index + 1, "finished_at": index + 2,
            })
        restarted = ExportJobStore(self.store.root)
        self.assertEqual([job["video_id"] for job in restarted.list()], ["second", "first"])
        self.assertEqual([job["video_id"] for job in restarted.list("first")], ["first"])
        self.assertEqual(restarted.list("missing"), [])

    def test_temporary_work_is_outside_saved_exports(self):
        workspaces = []
        async def generate(video_id, options, step, artifacts, workspace):
            workspaces.append(workspace)
            self.assertNotIn(self.store.root, workspace.parents)
            with export_workspace(step) as media:
                self.assertNotIn(self.store.root, media.parents)
                (media / "image.jpg").write_bytes(b"image")
            self.assertFalse(media.exists())
            path = workspace / "lecture.zip"
            path.write_bytes(b"zip")
            return SimpleNamespace(path=path)
        state = self.wait_for_job(self.store.start("video", {}, generate))
        self.assertEqual(state["status"], "complete")
        self.assertFalse(workspaces[0].exists())

    def test_cleanup_retries_a_transient_windows_lock(self):
        workspace = Path(tempfile.mkdtemp())
        (workspace / "clip.mp4").write_bytes(b"clip")
        remove = shutil.rmtree
        calls = []
        def locked_once(path):
            calls.append(path)
            if len(calls) == 1:
                raise PermissionError("File temporarily locked")
            remove(path)
        with patch("export_jobs.shutil.rmtree", side_effect=locked_once), patch("export_jobs._STATE_RETRY_DELAY", 0):
            cleanup_export_workspace(workspace)
        self.assertEqual(len(calls), 2)
        self.assertFalse(workspace.exists())

    def test_cleanup_failure_keeps_completed_export_with_visible_warning(self):
        workspaces = []
        async def generate(video_id, options, step, artifacts, workspace):
            workspaces.append(workspace)
            path = workspace / "lecture.zip"
            path.write_bytes(b"zip")
            return SimpleNamespace(path=path)
        try:
            with patch("export_jobs.shutil.rmtree", side_effect=PermissionError("Access denied")), \
                    patch("export_jobs._STATE_RETRY_DELAY", 0), self.assertLogs("export_jobs", level="WARNING"):
                state = self.wait_for_job(self.store.start("video", {}, generate))
            self.assertEqual(state["status"], "complete")
            self.assertTrue(any("Cleanup warning:" in step["message"] for step in state["steps"]))
            self.assertEqual(self.store.file(state["id"], state["download_file"]).read_bytes(), b"zip")
        finally:
            for workspace in workspaces:
                shutil.rmtree(workspace)

    def test_same_filename_exports_are_retained_separately(self):
        async def generate(video_id, options, step, artifacts, workspace):
            path = workspace / "lecture.zip"
            path.write_bytes(options["content"])
            return SimpleNamespace(path=path)
        first = self.store.start("video", {"content": b"first"}, generate)
        second = self.store.start("video", {"content": b"second"}, generate)
        for job_id, expected in ((first, b"first"), (second, b"second")):
            state = self.wait_for_job(job_id)
            self.assertEqual(state["status"], "complete")
            self.assertEqual(self.store.file(job_id, state["download_file"]).read_bytes(), expected)
        self.assertEqual(len(self.store.list("video")), 2)

    def test_running_work_does_not_block_status_and_restart_is_reported(self):
        release = threading.Event()
        self.addCleanup(release.set)
        async def generate(video_id, options, step, artifacts, workspace):
            step("Waiting for encoder")
            release.wait(timeout=3)
            path = workspace / "document.pdf"
            path.write_bytes(b"pdf")
            return SimpleNamespace(path=path)
        job_id = self.store.start("video", {}, generate)
        state = self.store.read(job_id)
        self.assertIn(state["status"], {"queued", "running"})
        restarted = ExportJobStore(Path(self.directory.name))
        self.assertEqual(restarted.read(job_id)["status"], "error")
        self.assertIn("restart", restarted.read(job_id)["error"])
        release.set()
        self.wait_for_job(job_id)

    def test_http_start_poll_preview_and_download(self):
        app = FastAPI()

        async def generate(video_id, request, step, artifacts, workspace):
            options = await request.json()
            self.assertEqual(options["document_title"], "Test lecture")
            step("Building HTML webpage")
            html = workspace / "index.html"
            html.write_text("<h1>Lecture</h1>", encoding="utf-8")
            artifacts(workspace, [html], options["document_title"])
            archive = workspace / "lecture.zip"
            archive.write_bytes(b"zip")
            return FileResponse(archive)

        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names = {
            "start_export_job", "read_export_job", "export_job_status",
            "saved_exports", "download_export_job", "open_export_webpage",
            "cancel_caption_export",
        }
        routes = ast.Module(
            body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                  and node.name in names], type_ignores=[],
        )
        namespace = {
            "app": app, "Request": Request, "HTTPException": HTTPException,
            "FileResponse": FileResponse, "export_jobs": self.store,
            "export_chapters": generate,
            "video_processor": SimpleNamespace(get_video_path=lambda video_id: "video.mp4"),
        }
        exec(compile(routes, str(source), "exec"), namespace)
        with TestClient(app) as client:
            response = client.post("/export_jobs/video", json={"document_title": "Test lecture"})
            self.assertEqual(response.status_code, 200)
            data = response.json()
            state = self.wait_for_job(data["job_id"])
            self.assertEqual(client.get(data["status_url"]).json()["status"], "complete")
            preview = client.get(state["open_url"])
            self.assertIn("text/html", preview.headers["content-type"])
            self.assertEqual(preview.text, "<h1>Lecture</h1>")
            self.assertEqual(client.get(state["download_url"]).content, b"zip")
            self.assertEqual(len(client.get("/saved_exports/video").json()["exports"]), 1)
            self.assertEqual(client.get("/export_jobs/bad/status").status_code, 404)
            self.assertEqual(client.post("/export_jobs/bad/cancel").status_code, 404)
            self.assertEqual(client.post(f"/export_jobs/{data['job_id']}/cancel").status_code, 400)
            caption_job = dict(state, title="Captioned video - English")
            self.store._write(data["job_id"], caption_job)
            self.assertEqual(client.post(f"/export_jobs/{data['job_id']}/cancel").json()["status"], "complete")
            async def pending(*args):
                await asyncio.sleep(60)
            pending_id = self.store.start("video", {"document_title": "Captioned video - Pending"}, pending)
            self.assertEqual(client.post(f"/export_jobs/{pending_id}/cancel").status_code, 200)
            self.assertEqual(self.wait_for_job(pending_id)["status"], "cancelled")
            self.assertEqual(client.get(f"/export_jobs/{pending_id}/download").status_code, 409)
            self.assertEqual(client.get(state["open_url"].replace("index.html", "missing.mp4")).status_code, 404)
            self.store.file(data["job_id"], state["download_file"]).unlink()
            self.assertEqual(client.get(state["download_url"]).status_code, 404)
