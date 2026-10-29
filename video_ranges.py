"""Validated timestamps shared by chapter generation and video cutting."""
import math
import re


def clip_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:\d+:)?\d+:[0-5]\d(?:\.\d{1,3})?", value):
        raise ValueError("Use MM:SS or HH:MM:SS timestamps, optionally with milliseconds.")
    if value.count(":") == 2 and int(value.split(":")[1]) >= 60:
        raise ValueError("Minutes in HH:MM:SS must be less than 60.")
    seconds = sum(float(part) * 60 ** index for index, part in enumerate(reversed(value.split(":"))))
    if not math.isfinite(seconds):
        raise ValueError("Timestamps must be finite.")
    return seconds


def split_ranges(cut_points, duration):
    if not isinstance(cut_points, list) or not 1 <= len(cut_points) <= 99:
        raise ValueError("Enter 1-99 cut timestamps (up to 100 parts).")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("The video must have a valid, positive duration.")
    cuts = [0, *(clip_timestamp(value) for value in cut_points), duration]
    if any(right <= left for left, right in zip(cuts, cuts[1:])):
        raise ValueError("Cut timestamps must be unique, increasing, and strictly between video start and end.")
    return list(zip(cuts, cuts[1:]))
