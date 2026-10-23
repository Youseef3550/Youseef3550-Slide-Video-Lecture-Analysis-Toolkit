"""Presentation order independent of immutable source clip boundaries."""
import copy
import re

from fastapi import HTTPException


def timestamp_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:\d+:)?\d+:[0-5]\d(?:\.\d{1,3})?", value):
        raise HTTPException(409, "Invalid saved clip timestamp. Reset clip order before continuing.")
    return sum(float(part) * 60 ** index for index, part in enumerate(reversed(value.split(":"))))


def section_arrangement(chapters):
    natural = [
        {"timestamp": part["timestamp"], "chapter": chapter["timestamp"]}
        for chapter in chapters for part in chapter.get("sections", [])
    ]
    saved = chapters[0].get("clip_arrangement") if chapters else None
    if saved is None:
        return natural
    starts = {timestamp_key(chapter["timestamp"]): chapter["timestamp"] for chapter in chapters}
    stamps = {timestamp_key(item["timestamp"]): item["timestamp"] for item in natural}
    if (not isinstance(saved, list) or len(saved) != len(natural)
            or any(not isinstance(item, dict) or timestamp_key(item.get("chapter")) not in starts
                   or not isinstance(item.get("timestamp"), str) for item in saved)
            or sorted(timestamp_key(item["timestamp"]) for item in saved) != sorted(stamps)):
        raise HTTPException(409, "Clip arrangement no longer matches the outline. "
                            "Reset clip order in Reorganize chapters before continuing.")
    normalized = [{"timestamp": stamps[timestamp_key(item["timestamp"])],
                   "chapter": starts[timestamp_key(item["chapter"])]} for item in saved]
    return [item for chapter in chapters for item in normalized if item["chapter"] == chapter["timestamp"]]


def reorder_section(chapters, operation):
    result = copy.deepcopy(chapters)
    if operation["action"] == "reset_clip_order":
        for chapter in result:
            chapter.pop("clip_arrangement", None)
        return result
    try:
        ci, si = operation["chapter"], operation["section"]
        ti, ts = operation["target_chapter"], operation["target_section"]
        if any(type(value) is not int or value < 0 for value in (ci, si, ti, ts)):
            raise ValueError()
        source, target = result[ci]["sections"][si], result[ti]["sections"][ts]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(400, "Choose existing source and target sections.") from error
    if ci == ti and si == ts:
        raise HTTPException(400, "Choose a different target section.")
    placement = operation.get("placement", "before")
    if not isinstance(placement, str) or placement not in {"before", "after"}:
        raise HTTPException(400, "Place the clip before or after its target.")
    if not any(item.get("flagged") or item.get("skipped") for item in (source, target, result[ci], result[ti])):
        raise HTTPException(400, "Reordering requires Review or Skip on the moved section or its target.")
    order = section_arrangement(result)
    moving = next(item for item in order if item["timestamp"] == source["timestamp"])
    destination = next(item for item in order if item["timestamp"] == target["timestamp"])
    order.remove(moving)
    moving["chapter"] = destination["chapter"]
    order.insert(order.index(destination) + (placement == "after"), moving)
    result[0]["clip_arrangement"] = order
    return result
