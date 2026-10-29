import asyncio
import copy
import json
import unittest
from unittest.mock import Mock, AsyncMock

from processors.summary_processor import SummaryProcessor


class OutlineReviewTests(unittest.TestCase):
    def setUp(self):
        self.processor = SummaryProcessor.__new__(SummaryProcessor)
        self.chapters = [{"timestamp": "00:00", "title": "Demo", "summary": "Keep this",
                          "sections": [{"timestamp": "00:00", "title": "Steps", "point": "Full explanation"}]}]
        self.transcript = [
            {"start": 0, "duration": 10, "text": "Here is our demonstration."},
            {"start": 10.125, "duration": 5, "text": "The connection is lost. Please wait."},
            {"start": 20.250, "duration": 5, "text": "We can continue our demonstration."},
        ]
        self.flag = {"start_id": 1, "last_id": 1, "opening_quote": "The connection is lost.",
                     "reason": "Waiting for reconnection", "confidence": 9}

    def review(self, flags):
        self.processor._complete = Mock(return_value=json.dumps({"flags": flags}))
        return asyncio.run(self.processor.review_disruptions(self.chapters, self.transcript, "groq", "test"))

    def test_suggestions_split_at_evidence_and_never_skip_or_change_original_starts(self):
        original = copy.deepcopy(self.chapters)
        result = self.review([self.flag])
        self.assertEqual(self.chapters, original)
        self.assertEqual(result[0]["timestamp"], "00:00")
        parts = result[0]["sections"]
        self.assertEqual([part["timestamp"] for part in parts], ["00:00", "00:10.125", "00:20.250"])
        self.assertFalse(parts[0].get("flagged"))
        self.assertTrue(parts[1]["flagged"])
        self.assertFalse(parts[2].get("flagged"))
        self.assertTrue(all(not part.get("skipped") for part in parts))
        self.assertTrue(all(part["point"] == "Full explanation" for part in parts))

    def test_no_evidence_keeps_outline_identical(self):
        self.assertEqual(self.review([]), self.chapters)

    def test_unsupported_ids_quotes_confidence_and_overlap_fail_explicitly(self):
        for changes in ({"start_id": True}, {"last_id": 100}, {"confidence": 5},
                        {"opening_quote": "Invented"}, {"reason": ""}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.review([{**self.flag, **changes}])
        with self.assertRaisesRegex(ValueError, "overlapping"):
            self.review([self.flag, self.flag])

    def test_flags_survive_normalization_without_propagating_to_resumed_instruction(self):
        chapters = [{"timestamp": "00:00", "title": "Demo", "sections": [
            {"timestamp": "00:00", "title": "Setup"},
            {"timestamp": "00:10", "title": "Steps", "flagged": True, "flag_reason": "Reconnection"},
            {"timestamp": "00:20", "title": "Steps"},
        ]}]
        result = self.processor._normalize_chapters(chapters, self.transcript)
        self.assertEqual(len(result[0]["sections"]), 3)
        self.assertEqual(result[0]["sections"][1]["flag_reason"], "Reconnection")
        self.assertNotIn("flagged", result[0]["sections"][2])

    def test_enhancement_cannot_merge_review_state_into_retained_instruction(self):
        sections = self.review([self.flag])[0]["sections"]
        units = [{"chapter": self.chapters[0], "section": section, "first": index == 0,
                  "point": section.get("point", "")} for index, section in enumerate(sections)]
        plan = {"chapters": [{"title": "Demo", "summary": "Summary",
                              "groups": [{"title": "One workflow", "indices": [0, 1, 2]}]}]}
        result = self.processor._apply_outline_groups(units, plan)
        self.assertEqual(len(result[0]["sections"]), 3)
        self.assertFalse(result[0]["sections"][0].get("flagged"))
        self.assertTrue(result[0]["sections"][1]["flagged"])
        self.assertFalse(result[0]["sections"][2].get("flagged"))

    def description_processor(self, responses):
        self.processor._refresh_clients = Mock()
        self.processor._provider_chain = Mock(return_value=[("groq", "test")])
        self.processor._complete = Mock(side_effect=responses)
        self.processor._is_model_unavailable = Mock(return_value=False)
        self.processor._is_quota_error = Mock(return_value=False)
        return self.processor

    def test_separated_description_is_validated_and_uses_selected_language_and_supplied_text_only(self):
        processor = self.description_processor([json.dumps({
            "title": "Connection recovery", "summary": "The demo continues after reconnection."})])
        excerpt = self.transcript[1:2]
        result = asyncio.run(processor.summarize_outline_part(excerpt, "de"))
        self.assertEqual(result["title"], "Connection recovery")
        prompt = processor._complete.call_args.args[2]
        self.assertIn("The connection is lost.", prompt)
        self.assertNotIn(self.transcript[0]["text"], prompt)
        self.assertIn("German", prompt)

    def test_empty_or_invalid_ai_description_is_not_saved_as_a_success(self):
        for response in ("", "not JSON", "[]", '{"title":"","summary":"Invented"}',
                         '{"title":"X","summary":""}', '{"title":"X","summary":42}'):
            with self.subTest(response=response):
                processor = self.description_processor([response])
                with self.assertRaises(RuntimeError):
                    asyncio.run(processor.summarize_outline_part(self.transcript, "en"))

    def test_long_separated_range_uses_all_text_reduction_instead_of_truncation(self):
        processor = self.description_processor(['{"title":"Topic","summary":"Both ends covered."}'])
        processor.generate_video_summary = AsyncMock(return_value={"summary": "Beginning and ending."})
        transcript = [{"start": 0, "text": "Beginning " + "details " * 2000}, {"start": 100, "text": "Ending"}]
        asyncio.run(processor.summarize_outline_part(transcript, "en"))
        processor.generate_video_summary.assert_awaited_once_with(transcript, transcript_language="en")
        self.assertIn("Beginning and ending.", processor._complete.call_args.args[2])
