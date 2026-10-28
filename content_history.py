"""Persistent, conflict-checked undo/redo for saved lecture content."""
import asyncio
import base64
from contextlib import contextmanager
import json
import logging
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
import zlib

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from project_paths import BASE_DIR, SCENES_DIR, SUMMARIES_DIR, TRANSCRIPTS_DIR

HISTORY_DB = BASE_DIR / ".lectureseek-history" / "content.sqlite3"
router = APIRouter()
_lock = threading.RLock()
_busy = set()
logger = logging.getLogger(__name__)
_ACTIONS = {
    "editable_content": "Edit saved content",
    "outline_item": "Edit chapter or section",
    "outline_selection": "Change selected sections",
    "chapter_tools": "Update or translate outline",
    "translate_transcript": "Translate transcript and chapters",
    "upload_transcript": "Replace uploaded transcript",
    "speaker_names": "Rename speakers",
}


def validate(video_id):
    if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", video_id):
        raise ValueError("Invalid video ID.")

@contextmanager
def save_lock():
    """Serialize short save transactions across the app and transcription workers."""
    with _lock:
        HISTORY_DB.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(HISTORY_DB.with_name("save-lock.sqlite3"), timeout=30)
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield
        finally:
            connection.rollback()
            connection.close()


@contextmanager
def _connection():
    HISTORY_DB.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(HISTORY_DB, timeout=30)
    try:
        with connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS actions (
                id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, label TEXT NOT NULL,
                created_at REAL NOT NULL, changes BLOB NOT NULL, undone INTEGER NOT NULL DEFAULT 0)""")
            yield connection
    finally:
        connection.close()


def _paths(video_id):
    paths = set(TRANSCRIPTS_DIR.glob(f"{video_id}*.json"))
    # Progress, worker backups and heartbeats are not editable lecture content.
    paths = {path for path in paths if not any(
        word in path.name for word in (
            "_phase", "_steps", "_heartbeat", "_backup", "_progress", "_error",
            "_whisper_pending", "_whisper_before_speakers",
        )
    )}
    paths.update((TRANSCRIPTS_DIR / "versions" / video_id).glob("*.json"))
    paths.update(SUMMARIES_DIR.glob(f"{video_id}*.json"))
    paths.update((SUMMARIES_DIR / "overviews" / video_id).glob("*.json"))
    scene = SCENES_DIR / f"{video_id}.json"
    if scene.is_file():
        paths.add(scene)
    # A short id must never match another video's content by prefix.
    return {path for path in paths if path.is_file() and (
        path.parent.name == video_id or path.name == f"{video_id}.json"
        or path.name.startswith(f"{video_id}_")
    )}


def capture(video_id):
    validate(video_id)
    return {str(path.resolve()): path.read_bytes() for path in _paths(video_id)}


def record(video_id, label, before):
    after = capture(video_id)
    changes = {path: [before.get(path), after.get(path)] for path in before.keys() | after.keys()
               if before.get(path) != after.get(path)}
    if not changes:
        return
    serial = {path: [base64.b64encode(value).decode("ascii") if value is not None else None for value in pair]
              for path, pair in changes.items()}
    blob = zlib.compress(json.dumps({"encoding": "base64", "changes": serial}).encode("utf-8"))
    with _lock, _connection() as connection:
        connection.execute("DELETE FROM actions WHERE video_id = ? AND undone = 1", (video_id,))
        connection.execute("INSERT INTO actions (video_id,label,created_at,changes) VALUES (?,?,?,?)",
                           (video_id, label, time.time(), blob))


def _running(video_id):
    return video_id in _busy or (TRANSCRIPTS_DIR / f"{video_id}_whisper_progress.txt").exists()


def status(video_id):
    validate(video_id)
    with _lock, _connection() as connection:
        undo = connection.execute("SELECT label FROM actions WHERE video_id=? AND undone=0 ORDER BY id DESC LIMIT 1",
                                  (video_id,)).fetchone()
        redo = connection.execute("SELECT label FROM actions WHERE video_id=? AND undone=1 ORDER BY id ASC LIMIT 1",
                                  (video_id,)).fetchone()
    return {"undo": undo[0] if undo else None, "redo": redo[0] if redo else None,
            "busy": _running(video_id)}


def view(video_id, language="", source="whisper", chapter_language=""):
    validate(video_id)
    if language not in ("", "en", "de", "ar", "pl") or chapter_language not in ("", "en", "de", "ar", "pl"):
        raise ValueError("Invalid content language.")
    if source not in ("whisper", "uploaded", "youtube"):
        raise ValueError("Invalid transcript source.")
    def read(path, default):
        return json.loads(path.read_text(encoding="utf-8-sig")) if path.is_file() else default
    active = read(TRANSCRIPTS_DIR / f"{video_id}_active_source.json", {})
    transcript_path = TRANSCRIPTS_DIR / (f"{video_id}_translated_{language}.json" if language
                                       else f"{video_id}_{source}.json")
    if not transcript_path.is_file() and not (
        source == "youtube" and not language and (TRANSCRIPTS_DIR / f"{video_id}.json").is_file()
    ):
        language = active.get("language", "") if active.get("kind") == "translation" else ""
        source = active.get("source", "whisper")
        transcript_path = TRANSCRIPTS_DIR / (f"{video_id}_translated_{language}.json" if language
                                           else f"{video_id}_{source}.json")
    transcript = read(transcript_path, None)
    if transcript is None and source == "youtube" and not language:
        transcript = read(TRANSCRIPTS_DIR / f"{video_id}.json", [])
    summary_path = SUMMARIES_DIR / (f"{video_id}_summary_{chapter_language}.json" if chapter_language else f"{video_id}.json")
    if not summary_path.is_file():
        chapter_language = language
        summary_path = SUMMARIES_DIR / (f"{video_id}_summary_{language}.json" if language else f"{video_id}.json")
    chapters = read(summary_path, [])
    return {"transcript": transcript or [], "chapters": chapters,
            "scenes": read(SCENES_DIR / f"{video_id}.json", []),
            "active_source": active, "transcript_language": language, "source": source,
            "chapter_language": chapter_language}


def _write(path, content):
    if content is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"~{uuid.uuid4().hex[:8]}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def restore(video_id, direction):
    validate(video_id)
    if direction not in ("undo", "redo"):
        raise ValueError("Invalid history action.")
    with _lock, _connection() as connection:
        if _running(video_id):
            raise ValueError("Finish or stop content generation before using Undo or Redo.")
        undone, order = (0, "DESC") if direction == "undo" else (1, "ASC")
        row = connection.execute(
            f"SELECT id,label,changes FROM actions WHERE video_id=? AND undone=? ORDER BY id {order} LIMIT 1",
            (video_id, undone)).fetchone()
        if row is None:
            raise ValueError(f"Nothing to {direction}.")
        saved = json.loads(zlib.decompress(row[2]))
        if saved.get("encoding") == "base64":
            changes = {name: [base64.b64decode(value, validate=True) if value is not None else None for value in pair]
                       for name, pair in saved["changes"].items()}
        else:
            changes = {name: [value.encode("utf-8") if value is not None else None for value in pair]
                       for name, pair in saved.items()}
        expected, target = (1, 0) if direction == "undo" else (0, 1)
        previous = {}
        for filename, pair in changes.items():
            path = Path(filename).resolve()
            if not any(path.is_relative_to(root.resolve()) for root in (TRANSCRIPTS_DIR, SUMMARIES_DIR, SCENES_DIR)):
                raise ValueError("History contains an invalid content path.")
            current = path.read_bytes() if path.is_file() else None
            if current != pair[expected]:
                raise ValueError("Saved content changed outside this history. Undo/Redo was not applied; reload the video.")
            previous[path] = current
        written = []
        try:
            for filename, pair in changes.items():
                path = Path(filename)
                _write(path, pair[target])
                written.append(path)
            connection.execute("UPDATE actions SET undone=? WHERE id=?", (1 - undone, row[0]))
            connection.commit()
        except (OSError, sqlite3.Error):
            for path in reversed(written):
                _write(path, previous[path])
            raise
        return {"success": True, "label": row[1], **status(video_id)}


@router.get("/content_history/{video_id}")
async def history_status(video_id: str):
    try:
        return await asyncio.to_thread(status, video_id)
    except (OSError, ValueError, sqlite3.Error) as error:
        logger.exception("Could not read content history for %s", video_id)
        raise HTTPException(500, f"Could not read Undo/Redo history: {error}") from error


@router.get("/content_history/{video_id}/content")
async def history_content(video_id: str, language: str = "", source: str = "whisper", chapter_language: str = ""):
    try:
        return await asyncio.to_thread(view, video_id, language, source, chapter_language)
    except (OSError, ValueError) as error:
        raise HTTPException(500, f"Could not reload restored content: {error}") from error


@router.post("/content_history/{video_id}/{direction}")
async def history_restore(video_id: str, direction: str):
    try:
        return await asyncio.to_thread(restore, video_id, direction)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    except (OSError, sqlite3.Error) as error:
        logger.exception("Could not restore content history for %s", video_id)
        raise HTTPException(500, f"Could not restore saved content: {error}") from error


class ContentHistoryMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method != "POST":
            return await call_next(request)
        parts = request.url.path.strip("/").split("/")
        video_id, label = None, None
        chapters = False
        existing_transcript = False
        if len(parts) == 2 and parts[0] in _ACTIONS:
            video_id, label = parts[1], _ACTIONS[parts[0]]
        elif parts == ["generate_summary"]:
            try:
                data = await request.json()
                if not isinstance(data, dict):
                    return await call_next(request)
                video_id = data.get("video_id")
                label = "Generate chapters"
                chapters = True
                existing_transcript = (
                    isinstance(data.get("transcript"), list) and bool(data["transcript"])
                    and data.get("basis", "topics") in ("topics", "timestamps")
                )
            except ValueError:
                return await call_next(request)
        elif len(parts) == 3 and parts[0] == "video_summary" and parts[2] == "generate":
            video_id, label = parts[1], "Generate video summary"
        if not video_id or not label:
            return await call_next(request)
        try:
            validate(video_id)
            with _lock:
                if video_id in _busy or (_running(video_id) and not (chapters and existing_transcript)):
                    return JSONResponse({"detail": "Another content operation is running. Finish or stop it first."}, status_code=409)
                _busy.add(video_id)
            before = {} if chapters else await asyncio.to_thread(capture, video_id)
        except (OSError, ValueError, sqlite3.Error) as error:
            with _lock:
                _busy.discard(video_id)
            logger.exception("Could not prepare Undo history for %s", video_id)
            return JSONResponse({"detail": f"Could not prepare Undo history; no change was started: {error}"}, status_code=500)
        try:
            response = await call_next(request)
            # Preserve partial saves too, even if a multi-file operation reports an error.
            if not chapters:
                await asyncio.to_thread(record, video_id, label, before)
            return response
        except (OSError, ValueError, sqlite3.Error) as error:
            logger.exception("Could not save Undo history for %s", video_id)
            return JSONResponse({"detail": f"The operation may have saved content, but Undo history failed: {error}"}, status_code=500)
        finally:
            with _lock:
                _busy.discard(video_id)
