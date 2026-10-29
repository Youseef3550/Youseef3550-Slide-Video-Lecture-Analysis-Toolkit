"""Read-only slide snapshots, including images, kept before a detection replaces them."""
import hashlib
import json
import re
import shutil
import uuid

from project_paths import SCENES_DIR, THUMBNAILS_DIR, FULLSIZE_IMAGES_DIR


def _validate(video_id):
    if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", video_id):
        raise ValueError("Invalid video ID.")


def archive(video_id):
    _validate(video_id)
    source = SCENES_DIR / f"{video_id}.json"
    if not source.is_file():
        return
    scenes = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(scenes, list):
        raise ValueError("Saved slides are invalid; refusing to replace them.")
    if not scenes:
        return
    diagnostics_path = SCENES_DIR / f"{video_id}_diagnostics.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8")) if diagnostics_path.is_file() else {}
    digest = hashlib.sha256(json.dumps([scenes, diagnostics], sort_keys=True).encode()).hexdigest()
    existing = list_sets(video_id, include_current=False)
    if any(item["digest"] == digest for item in existing):
        return
    snapshot_id = uuid.uuid4().hex[:16]
    directory = SCENES_DIR / "history" / snapshot_id
    directory.mkdir(parents=True)
    saved = []
    try:
        for index, scene in enumerate(scenes):
            row = dict(scene)
            for field, root, prefix in (("thumbnail", THUMBNAILS_DIR, "t"), ("fullsize", FULLSIZE_IMAGES_DIR, "f")):
                image = root / video_id / f"{index}.jpg"
                if not image.is_file():
                    raise ValueError(f"Slide {index + 1} is missing its {field} image; cannot safely archive it.")
                filename = f"{prefix}{index}.jpg"
                shutil.copyfile(image, directory / filename)
                row[field] = f"/static/scenes/history/{snapshot_id}/{filename}"
            saved.append(row)
        payload = {"id": snapshot_id, "video_id": video_id, "created_at": source.stat().st_mtime,
                   "digest": digest, "diagnostics": diagnostics, "scenes": saved}
        (directory / "snapshot.json").write_text(json.dumps(payload), encoding="utf-8")
    except (OSError, ValueError, TypeError):
        for file in directory.iterdir():
            file.unlink()
        directory.rmdir()
        raise


def list_sets(video_id, include_current=True):
    _validate(video_id)
    result = []
    for path in (SCENES_DIR / "history").glob("*/snapshot.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("video_id") == video_id:
            result.append(data)
    current = SCENES_DIR / f"{video_id}.json"
    if include_current and current.is_file():
        scenes = json.loads(current.read_text(encoding="utf-8"))
        if isinstance(scenes, list) and scenes:
            result.append({"id": "current", "video_id": video_id, "created_at": current.stat().st_mtime,
                           "digest": "", "diagnostics": {}, "scenes": scenes})
    return sorted(result, key=lambda item: item["created_at"], reverse=True)
