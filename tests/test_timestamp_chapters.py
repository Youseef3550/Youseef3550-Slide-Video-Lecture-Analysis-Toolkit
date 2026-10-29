import asyncio
import ast
import json
import re
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from fastapi.responses import JSONResponse
from processors import summary_processor
from processors.summary_processor import SummaryProcessor
from video_ranges import split_ranges


class TimestampChapterTests(unittest.TestCase):
    def processor(self):
        processor = SummaryProcessor.__new__(SummaryProcessor)
        processor._refresh_clients = mock.Mock()
        processor._provider_chain = mock.Mock(return_value=[("groq", "test-model")])
        processor._save_chapters = mock.Mock()
        processor._complete = mock.Mock(return_value=json.dumps({"title": "Same topic", "summary": "Full range."}))
        processor._verify_chapter_boundaries = mock.AsyncMock(side_effect=AssertionError("Do not move fixed cuts"))
        processor._verify_section_boundaries = mock.AsyncMock(side_effect=lambda chapters, *args: chapters)
        processor._chunked_chapters = mock.AsyncMock(side_effect=lambda provider, model, excerpt, *args: json.dumps([
            {"timestamp": processor._precise_stamp(excerpt[0]["start"]), "title": "Draft",
             "sections": [{"timestamp": processor._precise_stamp(excerpt[0]["start"]),
                           "title": "Section", "point": "All source text."}]},
        ]))
        processor.enhance_chapters = mock.AsyncMock(side_effect=lambda chapters, *args: chapters)
        return processor

    def test_exact_fractional_cuts_survive_two_passes_same_titles_and_silent_tail(self):
        processor = self.processor()
        transcript = [{"start": index * 5, "duration": 5, "text": f"Evidence {index}"} for index in range(6)]
        with mock.patch.object(summary_processor, "JSONResponse", JSONResponse):
            response = asyncio.run(processor.generate_summary(
                transcript, "video", basis="timestamps", cut_points=["00:10.125", "00:20.750", "00:35"],
                video_duration_seconds=40, language="en", passes="two", slide_starts=[0, 15],
            ))
        data = json.loads(response.body)
        self.assertTrue(data["success"], data)
        chapters = data["chapters"]
        self.assertEqual([processor._timestamp_value(chapter["timestamp"]) for chapter in chapters], [0, 10.125, 20.75, 35])
        self.assertEqual([chapter["title"] for chapter in chapters[:3]], ["Same topic"] * 3)
        self.assertTrue(chapters[3]["unassigned"])
        self.assertFalse(chapters[3]["skipped"])
        self.assertEqual(processor.enhance_chapters.await_count, 3)
        processor._verify_chapter_boundaries.assert_not_awaited()
        for chapter, end in zip(chapters, [10.125, 20.75, 35, 40]):
            start = processor._timestamp_value(chapter["timestamp"])
            for section in chapter.get("sections", []):
                self.assertTrue(start <= processor._timestamp_value(section["timestamp"]) < end)
        for call, (start, end) in zip(processor._chunked_chapters.call_args_list, [(0, 10.125), (10.125, 20.75), (20.75, 35)]):
            self.assertTrue(all(start <= cue["start"] < end and cue["start"] + cue["duration"] <= end
                                for cue in call.args[2]))
        processor._save_chapters.assert_called_once()

    def test_flat_timestamp_mode_still_has_title_and_summary_without_section_requests(self):
        processor = self.processor()
        with mock.patch.object(summary_processor, "JSONResponse", JSONResponse):
            response = asyncio.run(processor.generate_summary(
                [{"start": 0, "duration": 30, "text": "Shared utterance"}], None, basis="timestamps",
                cut_points=["00:10"], video_duration_seconds=30, structure="flat", language="en",
            ))
        data = json.loads(response.body)
        self.assertTrue(data["success"], data)
        self.assertEqual(len(data["chapters"]), 2)
        self.assertTrue(all(chapter["summary"] and "sections" not in chapter for chapter in data["chapters"]))
        processor._chunked_chapters.assert_not_awaited()
        self.assertEqual(processor._complete.call_count, 2)

    def test_invalid_cuts_do_not_call_ai_or_overwrite_saved_chapters(self):
        for cuts in ([], ["00:00"], ["00:10", "00:09"], ["00:10", "00:10"], ["00:30"], ["x"], [None]):
            with self.subTest(cuts=cuts):
                processor = self.processor()
                with mock.patch.object(summary_processor, "JSONResponse", JSONResponse):
                    response = asyncio.run(processor.generate_summary(
                        [{"start": 0, "duration": 30, "text": "Source"}], "video",
                        basis="timestamps", cut_points=cuts, language="en",
                    ))
                self.assertFalse(json.loads(response.body)["success"])
                processor._complete.assert_not_called()
                processor._save_chapters.assert_not_called()

    def test_missing_final_cue_duration_does_not_invent_evidence_in_later_parts(self):
        processor = self.processor()
        with mock.patch.object(summary_processor, "JSONResponse", JSONResponse):
            response = asyncio.run(processor.generate_summary(
                [{"start": 0, "text": "Opening"}, {"start": 10, "text": "Last timed words"}], None,
                basis="timestamps", cut_points=["00:20"], video_duration_seconds=30,
                structure="flat", language="en",
            ))
        data = json.loads(response.body)
        self.assertTrue(data["success"], data)
        self.assertEqual(data["chapters"][1]["title"], "No transcript text")
        self.assertEqual(processor._complete.call_count, 1)

    def test_shared_range_validation(self):
        self.assertEqual(split_ranges(["00:01.250", "00:02"], 3), [(0, 1.25), (1.25, 2), (2, 3)])
        for cuts, duration in ((None, 3), ("00:01", 3), (["00:01"] * 100, 3),
                               (["00:01:60"], 90), (["00:61"], 90), (["00:01"], float("nan")),
                               (["00:01"], 0), (["00:01"], 1)):
            with self.subTest(cuts=cuts, duration=duration), self.assertRaises(ValueError):
                split_ranges(cuts, duration)

    def test_route_uses_probed_video_end_and_does_not_load_slide_boundaries(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                        and node.name == "generate_summary")
        function.decorator_list = []
        processor = SimpleNamespace(generate_summary=mock.AsyncMock(return_value={"success": True}))
        source = mock.Mock(return_value=Path("video.mp4"))
        duration = mock.AsyncMock(return_value=3600.75)
        namespace = {"Request": object, "JSONResponse": lambda data: data,
                     "re": re, "asyncio": asyncio, "summary_generation_tasks": {},
                     "chapter_projects": SimpleNamespace(_media_source=source),
                     "video_duration": duration, "summary_processor": processor}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "<timestamp-route>", "exec"), namespace)
        result = asyncio.run(namespace["generate_summary"](SimpleNamespace(json=mock.AsyncMock(return_value={
            "video_id": "video", "basis": "timestamps", "cut_points": ["10:00", "25:00"],
            "consider_slides": True,
        }))))
        self.assertTrue(result["success"], result)
        source.assert_called_once_with("video", {})
        duration.assert_awaited_once_with(Path("video.mp4"))
        options = processor.generate_summary.call_args.kwargs
        self.assertEqual(options["video_duration_seconds"], 3600.75)
        self.assertEqual(options["cut_points"], ["10:00", "25:00"])
        self.assertIsNone(options["slide_starts"])
