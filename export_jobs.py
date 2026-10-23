import asyncio
import json
import logging
import re
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime

_STATE_LOCK = threading.Lock()
_STATE_RETRY_DELAY = 0.05
logger = logging.getLogger(__name__)


def cleanup_export_workspace(path, on_step=None):
    for attempt in range(4):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            if not path.exists():
                return
            error_message = f"Temporary files disappeared during cleanup: {path}"
        except OSError as error:
            error_message = f"Temporary export cleanup failed at {path}: {error}"
        if attempt < 3:
            time.sleep(0.1 * (attempt + 1))
    logger.warning(error_message)
    if on_step:
        on_step(f"Cleanup warning: {error_message}. Exported files were kept.")


@contextmanager
def export_workspace(on_step=None):
    # Keep intermediate media outside cloud-synced export directories.
    path = Path(tempfile.mkdtemp(prefix="lecture-export-"))
    try:
        yield path
    finally:
        cleanup_export_workspace(path, on_step)


class ExportJobStore:
    def __init__(self, root):
        self.root = Path(root)
        self.instance = uuid.uuid4().hex
        self._workers = {}
        self._workers_lock = threading.Lock()

    def cancel(self, job_id):
        state = self.read(job_id)
        if state["status"] not in {"queued", "running"}:
            return state
        with self._workers_lock:
            worker = self._workers.get(job_id)
            if worker is None:
                return self.read(job_id)
            if worker["cancelled"].is_set():
                return self.read(job_id)
            worker["cancelled"].set()
            if worker.get("loop") is not None:
                worker["loop"].call_soon_threadsafe(worker["task"].cancel)
        return self.read(job_id)

    def _directory(self, job_id):
        if len(job_id) != 32 or any(character not in "0123456789abcdef" for character in job_id):
            raise ValueError("Invalid export ID")
        return self.root / job_id

    def _write(self, job_id, state):
        directory = self._directory(job_id)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / "state.tmp"
        target = directory / "state.json"
        text = json.dumps(state, ensure_ascii=False)
        with _STATE_LOCK:
            # Cloud sync or antivirus can briefly lock state.json on Windows; retry, then write in place.
            error = None
            for attempt in range(6):
                try:
                    temporary.write_text(text, encoding="utf-8")
                    temporary.replace(target)
                    return
                except OSError as exc:
                    error = exc
                    time.sleep(_STATE_RETRY_DELAY * (attempt + 1))
            try:
                target.write_text(text, encoding="utf-8")
                return
            except OSError as exc:
                error = exc
        # A missed progress update must not abort the export; the next update retries.
        logger.warning("Could not save export progress for %s: %s", job_id, error)

    def read(self, job_id):
        path = self._directory(job_id) / "state.json"
        for attempt in range(6):
            try:
                with _STATE_LOCK:
                    state = json.loads(path.read_text(encoding="utf-8"))
                break
            except (PermissionError, json.JSONDecodeError):
                if attempt == 5:
                    raise
                time.sleep(_STATE_RETRY_DELAY * (attempt + 1))
        if state["status"] in {"queued", "running"} and state["instance"] != self.instance:
            state["status"] = "error"
            state["error"] = "Export interrupted by a server restart. Start a new export."
        state["elapsed"] = round(state.get("finished_at", time.time()) - state["created_at"], 1)
        return state

    def list(self, video_id=None):
        if not self.root.exists():
            return []
        exports = []
        for path in self.root.glob("*/state.json"):
            state = self.read(path.parent.name)
            if video_id is None or state["video_id"] == video_id:
                exports.append(state)
        return sorted(exports, key=lambda state: state["created_at"], reverse=True)

    def start(self, video_id, options, generate, *, caption_tracks=None, on_finish=None):
        job_id = uuid.uuid4().hex
        worker = {"cancelled": threading.Event()}
        state = {
            "id": job_id, "video_id": video_id, "instance": self.instance,
            "status": "queued", "created_at": time.time(), "steps": [],
            "title": options.get("document_title") or "Chapter export",
        }
        if caption_tracks:
            state["caption_tracks"] = caption_tracks

        def step(message):
            state["steps"].append({
                "elapsed": round(time.time() - state["created_at"], 1),
                "message": str(message),
            })
            self._write(job_id, state)

        def artifacts(directory, paths, title):
            if (directory / "index.html").is_file():
                destination = self._directory(job_id) / "webpage"
                destination.mkdir(parents=True, exist_ok=True)
                for path in paths:
                    shutil.copy2(path, destination / path.name)
                state["title"] = title
                state["open_url"] = f"/export_jobs/{job_id}/webpage/index.html"
                step("HTML webpage saved with its media for future sessions")

        async def work():
            workspace = None
            try:
                with self._workers_lock:
                    worker["loop"] = asyncio.get_running_loop()
                    worker["task"] = asyncio.current_task()
                if worker["cancelled"].is_set():
                    raise asyncio.CancelledError()
                workspace = Path(tempfile.mkdtemp(prefix="lecture-export-job-"))
                state["status"] = "running"
                step("Export worker started")
                response = await generate(video_id, options, step, artifacts, workspace)
                step("Saving the downloadable export")
                source = Path(response.path)
                target = self._directory(job_id) / ("download" + source.suffix)
                shutil.copy2(source, target)
                for index in range(len(state.get("caption_tracks", []))):
                    shutil.copy2(workspace / f"track-{index}.vtt",
                                 self._directory(job_id) / f"track-{index}.vtt")
                day = datetime.fromtimestamp(state["created_at"]).strftime("%Y-%m-%d")
                state["filename"] = (source.name if re.search(r"_\d{4}-\d{2}-\d{2}$", source.stem)
                                     else f"{source.stem}_{day}{source.suffix}")
                state["download_file"] = target.name
                state["download_url"] = f"/export_jobs/{job_id}/download"
                cleanup_export_workspace(workspace, step)
                if worker["cancelled"].is_set():
                    raise asyncio.CancelledError()
                state["status"] = "complete"
                state["finished_at"] = time.time()
                step("Export complete")
            except asyncio.CancelledError:
                if workspace is not None:
                    cleanup_export_workspace(workspace, step)
                directory = self._directory(job_id)
                for path in directory.glob("download.*"):
                    path.unlink()
                for path in directory.glob("track-*.vtt"):
                    path.unlink()
                for key in ("download_file", "download_url", "filename"):
                    state.pop(key, None)
                state["status"] = "cancelled"
                state["finished_at"] = time.time()
                step("Export stopped by user")
            except Exception as error:
                state["status"] = "error"
                state["finished_at"] = time.time()
                state["error"] = str(getattr(error, "detail", error))
                if workspace is not None:
                    cleanup_export_workspace(workspace, step)
                step(f"Export failed: {state['error']}")
            finally:
                if on_finish is not None:
                    on_finish()
                with self._workers_lock:
                    self._workers.pop(job_id, None)

        self._write(job_id, state)
        with self._workers_lock:
            self._workers[job_id] = worker
        thread = threading.Thread(target=lambda: asyncio.run(work()), name=f"export-{job_id}", daemon=True)
        thread.start()
        return job_id

    def file(self, job_id, filename, webpage=False):
        directory = self._directory(job_id)
        if webpage:
            directory = directory / "webpage"
        path = (directory / filename).resolve()
        if path.parent != directory.resolve() or not path.is_file():
            raise FileNotFoundError("Export file not found")
        return path
