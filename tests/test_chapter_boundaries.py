import asyncio
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from processors.summary_processor import SummaryProcessor


class ChapterBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.processor = SummaryProcessor.__new__(SummaryProcessor)
        self.chapters = [
            {"timestamp": "02:21", "title": "Demo 1 Translation", "sections": [
                {"timestamp": "02:21", "title": "Translation", "point": "First demo."},
                {"timestamp": "04:50", "title": "Cloud context", "point": "Preserve this detail."},
            ]},
            {"timestamp": "05:07", "title": "Demo 2 OneDrive", "sections": [
                {"timestamp": "05:07", "title": "OneDrive", "point": "Second demo."},
                {"timestamp": "06:01", "title": "Files", "point": "Use source files."},
            ]},
        ]
        self.transcript = [
            {"start": 141.76, "duration": 2, "text": "The first demo should show translation."},
            {"start": 270.28, "duration": 2.62, "text": "That was the first demo part."},
            {"start": 276.24, "duration": 3, "text": "If there are questions, address them at the end."},
            {"start": 279.84, "duration": 1.46, "text": "Otherwise demo two."},
            {"start": 287.98, "duration": 1.88, "text": "Second demo example, a bit different."},
            {"start": 293.9, "duration": 13.34, "text": "OneDrive is fully integrated."},
            {"start": 307.24, "duration": 3.96, "text": "Everyone knows this window."},
            {"start": 361, "duration": 3, "text": "Use files as context."},
        ]
        self.decisions = [
            {"chapter_index": 0, "transcript_id": 0, "opening_quote": "The first demo"},
            {"chapter_index": 1, "transcript_id": 3, "opening_quote": "Otherwise demo two."},
        ]
        self.processor._complete = Mock(return_value=json.dumps({"boundaries": self.decisions}))

    def verify(self):
        return asyncio.run(self.processor._verify_chapter_boundaries(
            self.chapters, self.transcript, "groq", "test"))

    def test_late_demo_cut_moves_to_transition_and_keeps_all_section_text(self):
        original = deepcopy(self.chapters)
        result = self.verify()
        self.assertEqual(result[1]["timestamp"], "04:39.840")
        self.assertAlmostEqual(307 - 279.84, 27.16)
        self.assertEqual(result[0]["sections"][0]["timestamp"], "02:21.760")
        self.assertEqual(len(result[0]["sections"]), 1)
        self.assertEqual([section["point"] for section in result[1]["sections"]],
                         ["Second demo.", "Preserve this detail.", "Use source files."])
        self.assertEqual(result[1]["sections"][0]["timestamp"], result[1]["timestamp"])
        self.assertEqual(self.chapters, original)
        prompt = self.processor._complete.call_args.args[2]
        self.assertIn("Otherwise demo two.", prompt)
        self.assertIn("Everyone knows this window.", prompt)
        self.assertIn("passing reference, future agenda announcement", prompt)
        self.assertEqual(result[1]["boundary_evidence"]["transcript_id"], 3)

    def test_real_31_second_correction_and_already_correct_cut(self):
        self.transcript[3]["start"] = 276
        result = self.verify()
        self.assertEqual(result[1]["timestamp"], "04:36")
        self.assertEqual(307 - 276, 31)
        self.chapters[1]["timestamp"] = "04:36"
        self.assertEqual(self.verify()[1]["timestamp"], "04:36", "No fixed offset on a correct cut")

    def test_slide_evidence_informs_verification_without_delaying_spoken_introduction(self):
        result = asyncio.run(self.processor._verify_chapter_boundaries(
            self.chapters, self.transcript, "groq", "test", slide_starts=[0, 300]))
        self.assertEqual(result[1]["timestamp"], "04:39.840")
        prompt = self.processor._complete.call_args.args[2]
        self.assertIn('"slide_changes": [300]', prompt)
        self.assertIn("not mandatory cuts", prompt)
        self.assertIn("Preserve spoken introductions", prompt)

    def test_verification_uses_evidence_in_any_transcript_language(self):
        for text in ("Jetzt Demo zwei.", "Teraz drugi pokaz.", "\u0627\u0644\u0622\u0646 \u0627\u0644\u0639\u0631\u0636 \u0627\u0644\u062b\u0627\u0646\u064a"):
            with self.subTest(text=text):
                self.transcript[3]["text"] = text
                self.decisions[1]["opening_quote"] = text
                self.processor._complete.return_value = json.dumps({"boundaries": self.decisions})
                self.assertEqual(self.verify()[1]["timestamp"], "04:39.840")

    def test_moved_sections_get_a_synchronized_anchor_in_a_previously_flat_chapter(self):
        del self.chapters[1]["sections"]
        result = self.verify()
        self.assertEqual(result[1]["sections"][0]["timestamp"], result[1]["timestamp"])
        self.assertEqual(result[1]["sections"][1]["point"], "Preserve this detail.")

    def test_later_correction_moves_crossed_sections_back_without_losing_text(self):
        self.chapters[1]["timestamp"] = "04:36"
        self.chapters[1]["sections"] = [
            {"timestamp": "04:36", "title": "OneDrive", "point": "Second demo."},
            {"timestamp": "04:45", "title": "Question", "point": "Keep this question."},
            {"timestamp": "06:01", "title": "Files", "point": "Use source files."},
        ]
        self.decisions[1] = {"chapter_index": 1, "transcript_id": 6,
                             "opening_quote": "Everyone knows this window."}
        self.processor._complete.return_value = json.dumps({"boundaries": self.decisions})
        result = self.verify()
        self.assertEqual(result[1]["timestamp"], "05:07.240")
        self.assertIn("Keep this question.", [part["point"] for part in result[0]["sections"]])
        self.assertEqual(result[1]["sections"][0]["timestamp"], "05:07.240")

    def test_invalid_missing_duplicate_and_unsupported_evidence_are_rejected(self):
        invalid = [
            [],
            [self.decisions[0], self.decisions[0]],
            list(reversed(self.decisions)),
            [self.decisions[0], {**self.decisions[1], "transcript_id": True}],
            [self.decisions[0], {**self.decisions[1], "chapter_index": True}],
            [self.decisions[0], {**self.decisions[1], "transcript_id": 999}],
            [self.decisions[0], {**self.decisions[1], "opening_quote": "Invented words"}],
            [self.decisions[0], {**self.decisions[1], "opening_quote": ""}],
        ]
        for decisions in invalid:
            with self.subTest(decisions=decisions):
                self.processor._complete.return_value = json.dumps({"boundaries": decisions})
                with self.assertRaises(ValueError):
                    self.verify()

    def test_crossing_verified_boundaries_are_rejected(self):
        self.chapters[1]["timestamp"] = "02:50"
        self.transcript = [{"start": 150, "text": "First utterance"}, {"start": 160, "text": "Second utterance"}]
        self.processor._complete.return_value = json.dumps({"boundaries": [
            {"chapter_index": 0, "transcript_id": 1, "opening_quote": "Second utterance"},
            {"chapter_index": 1, "transcript_id": 0, "opening_quote": "First utterance"},
        ]})
        with self.assertRaisesRegex(ValueError, "overlap"):
            self.verify()

    def test_missing_transcript_evidence_fails_instead_of_saving_a_guessed_start(self):
        self.transcript = self.transcript[:1]
        with self.assertRaisesRegex(ValueError, "No transcript evidence"):
            self.verify()

    def test_verified_milliseconds_survive_saving_and_reload(self):
        result = self.verify()
        with tempfile.TemporaryDirectory() as directory, patch(
                "processors.summary_processor.SUMMARIES_DIR", Path(directory)):
            (Path(directory) / "video.json").write_text(json.dumps(result), encoding="utf-8")
            with patch.object(self.processor, "_looks_like_legacy_fallback", return_value=True):
                response = asyncio.run(self.processor.get_summary("video"))
        self.assertEqual(json.loads(response.body)["chapters"], result)

    def test_verification_is_mandatory_after_either_outline_pass_and_slide_rules(self):
        self.processor._refresh_clients = Mock()
        self.processor._provider_chain = Mock(return_value=[("groq", "test")])
        self.processor._chunked_chapters = AsyncMock(return_value=json.dumps(self.chapters))
        self.processor.enhance_chapters = AsyncMock(side_effect=lambda chapters, *args: chapters)
        self.processor._verify_section_boundaries = AsyncMock(side_effect=lambda chapters, *args: chapters)
        self.processor._save_chapters = Mock()
        for passes in ("one", "two"):
            for structure in ("flat", "sections"):
                for slides in (None, [0, 275]):
                    with self.subTest(passes=passes, structure=structure, slides=slides), patch(
                            "processors.summary_processor.JSONResponse", side_effect=lambda content: SimpleNamespace(content=content)):
                        response = asyncio.run(self.processor.generate_summary(
                            self.transcript, "video", passes=passes, structure=structure, slide_starts=slides))
                    self.assertTrue(response.content["success"], response.content)
                    self.assertEqual(response.content["chapters"][1]["timestamp"], "04:39.840",
                                     "Slide alignment must not overwrite the verified topic transition")
                    self.assertTrue(response.content["chapters"][1]["boundary_verified"])
        self.assertEqual(self.processor._save_chapters.call_count, 8)
        self.assertEqual(self.processor._verify_section_boundaries.await_count, 8)
        self.processor._save_chapters.reset_mock()
        self.processor._complete.side_effect = RuntimeError("Boundary verification service failed")
        with patch("processors.summary_processor.JSONResponse", side_effect=lambda content: SimpleNamespace(content=content)):
            response = asyncio.run(self.processor.generate_summary(self.transcript, "video"))
        self.assertFalse(response.content["success"])
        self.assertIn("Boundary verification service failed", response.content["error"])
        self.processor._save_chapters.assert_not_called()

    def test_long_outline_uses_batches_without_omitting_boundaries(self):
        self.chapters = [{"timestamp": f"{index:02d}:00", "title": f"Topic {index}"} for index in range(20)]
        self.transcript = [{"start": index * 60, "text": f"Topic {index} " + "word " * 200} for index in range(20)]
        def complete(provider, model, prompt, *args):
            batch = json.loads(prompt.split("No invented timestamps.\n")[1])
            return json.dumps({"boundaries": [
                {"chapter_index": item["chapter_index"], "transcript_id": item["chapter_index"],
                 "opening_quote": f"Topic {item['chapter_index']} "}
                for item in batch
            ]})
        self.processor._complete.side_effect = complete
        result = self.verify()
        self.assertEqual([item["timestamp"] for item in result],
                         [item["timestamp"] for item in self.chapters])
        self.assertGreater(self.processor._complete.call_count, 1)

    def test_powerpoint_cut_excludes_excel_wrap_up_and_preserves_fractional_evidence(self):
        self.chapters = [
            {"timestamp": "03:57", "title": "Excel Demo"},
            {"timestamp": "09:13", "title": "PowerPoint Demo"},
        ]
        self.transcript = [
            {"start": 237.12, "text": "Now let us try Excel."},
            {"start": 550.68, "text": "Copilot can also make changes in the Excel sheets we already have open."},
            {"start": 555.68, "text": "As long as we allow it."},
            {"start": 556.84, "text": "We have Copilot in basically all Microsoft apps."},
            {"start": 569.68, "text": "We will now focus on PowerPoint."},
            {"start": 577.28, "text": "And when we jump over to PowerPoint, I am now in the web version."},
        ]
        self.processor._complete.return_value = json.dumps({"boundaries": [
            {"chapter_index": 0, "transcript_id": 0, "opening_quote": self.transcript[0]["text"]},
            {"chapter_index": 1, "transcript_id": 4, "opening_quote": self.transcript[4]["text"]},
        ]})
        result = self.verify()
        self.assertEqual(result[1]["timestamp"], "09:29.680")
        self.assertIn("preceding demo's wrap-up", self.processor._complete.call_args.args[2])

    def test_section_verification_failure_does_not_save_a_generated_outline(self):
        self.processor._refresh_clients = Mock()
        self.processor._provider_chain = Mock(return_value=[("groq", "test")])
        self.processor._chunked_chapters = AsyncMock(return_value=json.dumps(self.chapters))
        self.processor._verify_section_boundaries = AsyncMock(side_effect=ValueError("Section evidence failed"))
        self.processor._save_chapters = Mock()
        response = asyncio.run(self.processor.generate_summary(self.transcript, "video"))
        data = json.loads(response.body)
        self.assertFalse(data["success"])
        self.assertIn("Section evidence failed", data["error"])
        self.processor._save_chapters.assert_not_called()


class SectionBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.processor = SummaryProcessor.__new__(SummaryProcessor)
        self.chapters = [
            {"timestamp": "09:29.680", "title": "PowerPoint Demo", "sections": [
                {"timestamp": "09:29.680", "title": "Opening Copilot", "point": "Open the pane."},
                {"timestamp": "10:18", "title": "Prompting", "point": "Use email and attachments."},
                {"timestamp": "11:01", "title": "Brand Kit", "point": "Apply brand settings."},
            ]},
            {"timestamp": "13:13", "title": "Next topic"},
        ]
        self.transcript = [
            {"start": 569.68, "text": "We will now focus on PowerPoint."},
            {"start": 614.2, "text": "That is how you open the pane."},
            {"start": 623.18, "text": "Now create a presentation from this email and attachment."},
            {"start": 661.26, "text": "I can search for the project data."},
            {"start": 666.78, "text": "Before sending it, choose a brand kit."},
            {"start": 793, "text": "The next topic begins here."},
        ]
        self.decisions = [
            {"section_index": 0, "transcript_id": 2, "opening_quote": self.transcript[2]["text"]},
            {"section_index": 1, "transcript_id": 4, "opening_quote": self.transcript[4]["text"]},
        ]
        self.processor._complete = Mock(return_value=json.dumps({"boundaries": self.decisions}))

    def verify(self):
        return asyncio.run(self.processor._verify_section_boundaries(
            self.chapters, self.transcript, "groq", "test"))

    def test_sections_use_their_own_transcript_evidence_without_changing_text_or_chapter_start(self):
        original = deepcopy(self.chapters)
        result = self.verify()
        self.assertEqual([section["timestamp"] for section in result[0]["sections"]],
                         ["09:29.680", "10:23.180", "11:06.780"])
        self.assertEqual(result[0]["timestamp"], original[0]["timestamp"])
        self.assertEqual([section["point"] for section in result[0]["sections"]],
                         [section["point"] for section in original[0]["sections"]])
        self.assertEqual(self.chapters, original)
        self.assertTrue(result[0]["sections"][1]["boundary_verified"])
        self.assertEqual(result[0]["sections"][1]["boundary_evidence"]["transcript_id"], 2)

    def test_evidence_from_outside_the_chapter_or_before_the_previous_section_is_rejected(self):
        for cue_id in (0, 5):
            self.decisions[1]["transcript_id"] = cue_id
            self.decisions[1]["opening_quote"] = self.transcript[cue_id]["text"]
            self.processor._complete.return_value = json.dumps({"boundaries": self.decisions})
            with self.subTest(cue_id=cue_id), self.assertRaisesRegex(ValueError, "unsupported transcript"):
                self.verify()

    def test_missing_or_invented_section_evidence_is_rejected(self):
        for decisions in ([], self.decisions[:1], [
                self.decisions[0], {**self.decisions[1], "opening_quote": "Invented words"}]):
            self.processor._complete.return_value = json.dumps({"boundaries": decisions})
            with self.subTest(decisions=decisions), self.assertRaises(ValueError):
                self.verify()

    def test_overlapping_corrected_sections_are_rejected(self):
        self.transcript.insert(4, {"start": 640, "text": "Shared transition."})
        self.decisions = [
            {"section_index": 0, "transcript_id": 4, "opening_quote": "Shared transition."},
            {"section_index": 1, "transcript_id": 4, "opening_quote": "Shared transition."},
        ]
        self.processor._complete.return_value = json.dumps({"boundaries": self.decisions})
        with self.assertRaisesRegex(ValueError, "overlap"):
            self.verify()

    def test_fractional_chapter_limit_is_not_rounded_down(self):
        self.chapters[1]["timestamp"] = "11:06.900"
        result = self.verify()
        self.assertEqual(result[0]["sections"][-1]["timestamp"], "11:06.780")

    def test_flat_or_single_section_outlines_do_not_need_an_extra_model_call(self):
        self.chapters[0]["sections"] = self.chapters[0]["sections"][:1]
        self.verify()
        self.processor._complete.assert_not_called()

    def test_missing_local_evidence_fails_explicitly(self):
        self.transcript = self.transcript[:1]
        with self.assertRaisesRegex(ValueError, "No transcript evidence near section"):
            self.verify()

    def test_verified_section_milliseconds_survive_reload(self):
        result = self.verify()
        result[0]["boundary_verified"] = True
        with tempfile.TemporaryDirectory() as directory, patch(
                "processors.summary_processor.SUMMARIES_DIR", Path(directory)):
            (Path(directory) / "video.json").write_text(json.dumps(result), encoding="utf-8")
            response = asyncio.run(self.processor.get_summary("video"))
        self.assertEqual(json.loads(response.body)["chapters"], result)


class SpeakerChapterTests(unittest.TestCase):
    def setUp(self):
        self.processor = SummaryProcessor.__new__(SummaryProcessor)
        self.processor._save_chapters = Mock()
        self.processor._refresh_clients = Mock()
        self.processor._provider_chain = Mock(return_value=[("groq", "test")])
        self.transcript = [
            {"start": 0.25, "duration": 9.75, "text": "One", "speaker": "S0", "speaker_name": "Alice"},
            {"start": 10, "duration": 10, "text": "Two", "speaker": "S0", "speaker_name": "Alice"},
            {"start": 20.125, "duration": 10, "text": "Three", "speaker": "S1", "speaker_name": "Bob"},
            {"start": 30, "duration": 10, "text": "Four", "speaker": "S0", "speaker_name": "Alice"},
        ]

    def generate(self, **kwargs):
        response = asyncio.run(self.processor.generate_summary(self.transcript, "video", **kwargs))
        return json.loads(response.body)

    def test_speaker_only_mode_needs_no_ai_and_preserves_every_change(self):
        result = self.generate(basis="speakers", slide_starts=[0], transcript_language="en")
        self.assertTrue(result["success"], result)
        chapters = result["chapters"]
        self.assertEqual([chapter["timestamp"] for chapter in chapters], ["00:00.250", "00:20.125", "00:30"])
        self.assertEqual([chapter["title"] for chapter in chapters], ["Alice", "Bob", "Alice"])
        self.processor._refresh_clients.assert_not_called()
        self.assertEqual(self.processor._save_chapters.call_args.args[2], "en")

    def test_topics_and_speakers_preserves_union_of_boundaries_and_sections(self):
        draft = [
            {"timestamp": "00:00.250", "title": "Introduction", "summary": "Original summary",
             "sections": [{"timestamp": "00:00.250", "title": "Opening", "point": "First point"},
                          {"timestamp": "00:10", "title": "Detail", "point": "Second point"}]},
            {"timestamp": "00:25", "title": "Demonstration",
             "sections": [{"timestamp": "00:25", "title": "Example", "point": "Third point"}]},
        ]
        self.processor._chunked_chapters = AsyncMock(return_value=json.dumps(draft))
        self.processor._verify_chapter_boundaries = AsyncMock(side_effect=lambda chapters, *args: chapters)
        self.processor._verify_section_boundaries = AsyncMock(side_effect=lambda chapters, *args: chapters)
        for structure in ("flat", "sections"):
            with self.subTest(structure=structure):
                result = self.generate(basis="topics_speakers", structure=structure, slide_starts=[0])
                self.assertTrue(result["success"], result)
                chapters = result["chapters"]
                self.assertEqual([chapter["timestamp"] for chapter in chapters],
                                 ["00:00.250", "00:20.125", "00:25", "00:30"])
                self.assertEqual([chapter["speaker"] for chapter in chapters], ["S0", "S1", "S1", "S0"])
                self.assertEqual(chapters[2]["title"], "Bob - Demonstration")
                self.assertEqual([section["point"] for chapter in chapters
                                  for section in chapter.get("sections", []) if "point" in section],
                                 ["First point", "Second point", "Third point"])

    def test_missing_invalid_and_simultaneous_labels_fail_without_saving(self):
        for change in ({"speaker": None, "speaker_name": None}, {"start": -1},
                       {"start": float("nan")}, {"start": float("inf")}, {"start": True}):
            with self.subTest(change=change):
                old = deepcopy(self.transcript)
                self.transcript[2].update(change)
                result = self.generate(basis="speakers")
                self.assertFalse(result["success"])
                self.processor._save_chapters.assert_not_called()
                self.transcript = old
        self.transcript[2]["start"] = 10
        self.assertFalse(self.generate(basis="speakers")["success"])
        self.assertFalse(self.generate(basis="invalid")["success"])

    def test_names_do_not_merge_distinct_speaker_ids(self):
        self.transcript[2]["speaker_name"] = "Alice"
        self.assertEqual(len(self.generate(basis="speakers")["chapters"]), 3)
