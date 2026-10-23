"""Read-only, literal keyword search over saved lecture content."""
import json
import logging
import math
import re

from fastapi import APIRouter, HTTPException, Query
from project_paths import VIDEO_DIR, TRANSCRIPTS_DIR, SUMMARIES_DIR

router = APIRouter()
logger = logging.getLogger(__name__)
KINDS = {"all", "video", "transcript", "chapter", "section", "summary"}
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _time(value):
    try:
        seconds = (sum(float(part) * 60 ** index for index, part in enumerate(reversed(value.split(":"))))
                   if isinstance(value, str) else float(value))
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


@router.get("/library/search")
def search_library(q: str = Query(..., min_length=1, max_length=200), kind: str = "all",
                   offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
                   project_id: str = ""):
    query = q.strip()
    if not query or len(query) > 200 or kind not in KINDS:
        raise HTTPException(400, "Enter a keyword or phrase up to 200 characters and a valid content type.")
    if project_id and not SAFE_ID.fullmatch(project_id):
        raise HTTPException(400, "Invalid project ID.")
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    warnings, results, seen = [], [], set()

    def read(path, expected):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, expected):
                raise ValueError("Unexpected saved content format.")
            return data
        except (OSError, ValueError) as error:
            logger.warning("Could not search %s: %s", path, error)
            warnings.append(f"Could not search {path.name}: {error}")
            return None

    def add(video_id, filename, category, title, text, timestamp=None, source="Saved content"):
        if kind not in ("all", category) or not isinstance(text, str):
            return
        match = pattern.search(text)
        if not match:
            return
        key = (video_id, category, timestamp, text)
        if key in seen:
            return
        seen.add(key)
        start, end = max(0, match.start() - 90), min(len(text), match.end() + 150)
        snippet = ("..." if start else "") + text[start:end] + ("..." if end < len(text) else "")
        results.append({"video_id": video_id, "filename": filename, "kind": category,
                        "title": title, "snippet": snippet, "timestamp": timestamp, "source": source})

    def transcript(video_id, filename, cues, source):
        if not isinstance(cues, list):
            logger.warning("Invalid saved transcript for %s (%s)", video_id, source)
            warnings.append(f"{filename}: invalid transcript in {source}.")
            return
        for cue in cues:
            if isinstance(cue, dict):
                add(video_id, filename, "transcript", "Transcript", cue.get("text"),
                    _time(cue.get("start")), source)

    def outline(video_id, filename, chapters, source):
        if not isinstance(chapters, list):
            logger.warning("Invalid saved chapters for %s (%s)", video_id, source)
            warnings.append(f"{filename}: invalid chapters in {source}.")
            return
        if chapters and all(isinstance(group, list) for group in chapters):
            chapters = [chapter for group in chapters for chapter in group]
        for chapter in chapters:
            if not isinstance(chapter, dict):
                continue
            title = str(chapter.get("title", "Chapter"))
            start = _time(chapter.get("timestamp"))
            add(video_id, filename, "chapter", title, title, start, source)
            add(video_id, filename, "summary", title, chapter.get("summary"), start, source)
            sections = chapter.get("sections") or []
            if not isinstance(sections, list):
                logger.warning("Invalid saved sections for %s (%s)", video_id, source)
                warnings.append(f"{filename}: invalid sections in {source}.")
                continue
            for section in sections:
                if not isinstance(section, dict):
                    continue
                name = str(section.get("title", "Section"))
                text = "\n".join(value for value in [name, section.get("point")] if isinstance(value, str))
                add(video_id, filename, "section", name, text, _time(section.get("timestamp")), source)

    try:
        metadata_path = VIDEO_DIR / "metadata.json"
        metadata = read(metadata_path, dict) if metadata_path.is_file() else {}
        videos = sorted({path.stem for path in VIDEO_DIR.iterdir()
                         if path.is_file() and path.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"}
                         and SAFE_ID.fullmatch(path.stem)})
        for video_id in videos:
            if project_id and video_id != project_id:
                continue
            entry = (metadata or {}).get(video_id, {})
            filename = str(entry.get("filename") or entry.get("title") or video_id) if isinstance(entry, dict) else video_id
            add(video_id, filename, "video", filename, filename, source="Video name")
            for suffix, source in [("whisper", "Current transcript"), ("uploaded", "Uploaded transcript"),
                                   ("youtube", "YouTube captions"),
                                   *[(f"translated_{language}", f"{language.upper()} translation")
                                     for language in ("en", "de", "ar", "pl")]]:
                path = TRANSCRIPTS_DIR / f"{video_id}_{suffix}.json"
                if path.is_file():
                    cues = read(path, list)
                    if cues is not None:
                        transcript(video_id, filename, cues, source)
            legacy = TRANSCRIPTS_DIR / f"{video_id}.json"
            if legacy.is_file():
                cues = read(legacy, list)
                if cues is not None:
                    transcript(video_id, filename, cues, "Saved captions")
            for suffix, source in [("", "Saved outline"), *[(f"_summary_{language}", f"{language.upper()} outline")
                                                          for language in ("en", "de", "ar", "pl")]]:
                path = SUMMARIES_DIR / f"{video_id}{suffix}.json"
                if path.is_file():
                    chapters = read(path, list)
                    if chapters is not None:
                        outline(video_id, filename, chapters, source)
            version_dir = TRANSCRIPTS_DIR / "versions" / video_id
            index_path = version_dir / "index.json"
            entries = read(index_path, list) if index_path.is_file() else []
            for entry in entries or []:
                if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not SAFE_ID.fullmatch(entry["id"]):
                    continue
                stored = read(version_dir / f"{entry['id']}.json", dict)
                if stored is None:
                    continue
                source = f"Saved version: {entry.get('label') or entry['id']}"
                transcript(video_id, filename, stored.get("transcript", []), source)
                outline(video_id, filename, stored.get("chapters", []), source)
            for path in sorted((SUMMARIES_DIR / "overviews" / video_id).glob("*.json")):
                overview = read(path, dict)
                if overview is not None:
                    add(video_id, filename, "summary", "Video summary", overview.get("summary"),
                        source="Saved video summary")
    except OSError as error:
        logger.exception("Could not search saved videos")
        raise HTTPException(500, f"Could not search saved videos: {error}") from error
    return {"query": query, "total": len(results), "offset": offset,
            "results": results[offset:offset + limit], "warnings": warnings}
