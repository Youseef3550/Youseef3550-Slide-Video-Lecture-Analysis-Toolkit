import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import library_search


class LibrarySearchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("VIDEO_DIR", "TRANSCRIPTS_DIR", "SUMMARIES_DIR"):
            path = self.root / name
            path.mkdir()
            setattr(self, name, path)
            patch = mock.patch.object(library_search, name, path)
            patch.start()
            self.addCleanup(patch.stop)
        app = FastAPI()
        app.include_router(library_search.router)
        self.client = TestClient(app)
        (self.VIDEO_DIR / "first.mp4").write_bytes(b"video")
        (self.VIDEO_DIR / "second.webm").write_bytes(b"video")
        self.write(self.VIDEO_DIR / "metadata.json", {
            "first": {"filename": "Gradient workshop.mp4"}, "second": {"filename": "Second lecture.webm"},
        })
        self.cues = [{"start": 12.125, "text": "Gradient descent reduces loss."}]
        self.chapters = [{
            "timestamp": "00:10.125", "title": "Gradient",
            "summary": "The gradient points uphill.", "sections": [
                {"timestamp": "00:12.125", "title": "Steps", "point": "A gradient update changes weights."},
            ],
        }]
        self.write(self.TRANSCRIPTS_DIR / "first_whisper.json", self.cues)
        self.write(self.SUMMARIES_DIR / "first.json", self.chapters)
        self.write(self.TRANSCRIPTS_DIR / "second_uploaded.json", [{"start": 3, "text": "Another gradient example."}])
        self.write(self.TRANSCRIPTS_DIR / "first_translated_de.json",
                   [{"start": 12.125, "text": "Gradient auf Deutsch."}])
        self.write(self.SUMMARIES_DIR / "first_summary_de.json",
                   [{"timestamp": "00:10", "title": "Gradient auf Deutsch"}])
        self.write(self.SUMMARIES_DIR / "overviews" / "first" / "hash.json",
                   {"summary": "Gradient methods optimize the model."})
        self.write(self.TRANSCRIPTS_DIR / "versions" / "first" / "index.json", [
            {"id": "t-old", "label": "Earlier transcript"}, {"id": "t-duplicate", "label": "Same text"},
        ])
        self.write(self.TRANSCRIPTS_DIR / "versions" / "first" / "t-old.json", {
            "transcript": [{"start": 4.5, "text": "An earlier gradient explanation."}],
            "chapters": [{"timestamp": "00:04.500", "title": "Old gradient chapter"}],
        })
        self.write(self.TRANSCRIPTS_DIR / "versions" / "first" / "t-duplicate.json",
                   {"transcript": self.cues, "chapters": self.chapters})

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def search(self, query="gradient", **options):
        response = self.client.get("/library/search", params={"q": query, **options})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_all_saved_sources_are_searched_without_duplicate_version_results(self):
        result = self.search()
        self.assertEqual(result["warnings"], [])
        rows = result["results"]
        self.assertEqual({row["kind"] for row in rows}, {"video", "transcript", "chapter", "section", "summary"})
        self.assertEqual({row["video_id"] for row in rows}, {"first", "second"})
        self.assertEqual(len([row for row in rows if row["snippet"] == self.cues[0]["text"]]), 1)
        self.assertTrue(any(row["source"] == "DE translation" for row in rows))
        self.assertTrue(any(row["source"] == "DE outline" for row in rows))
        self.assertTrue(any(row["source"] == "Saved version: Earlier transcript" for row in rows))
        self.assertTrue(any(row["source"] == "Saved video summary" and row["timestamp"] is None for row in rows))
        self.assertTrue(any(row["kind"] == "section" and row["timestamp"] == 12.125 for row in rows))
        self.assertTrue(any(row["kind"] == "summary" and row["timestamp"] == 10.125 for row in rows))
        self.assertTrue(all("path" not in row for row in rows))

    def test_literal_unicode_and_html_search_is_safe(self):
        self.write(self.TRANSCRIPTS_DIR / "first_youtube.json", [
            {"start": 1, "text": "Überblick العربية C++ [demo] <script>alert(1)</script>"},
        ])
        for query in ("überblick", "العربية", "C++", "[demo]", "<script>"):
            with self.subTest(query=query):
                result = self.search(query)
                self.assertEqual(result["total"], 1)
        self.assertEqual(self.search(".*")["total"], 0, "Queries are not regular expressions")

    def test_open_project_filter_applies_before_pagination_and_skips_other_files(self):
        self.write(self.TRANSCRIPTS_DIR / "second_uploaded.json", "invalid format")
        result = self.search(project_id="first", limit=2)
        self.assertTrue(all(row["video_id"] == "first" for row in result["results"]))
        self.assertEqual(result["warnings"], [])
        self.assertGreater(result["total"], 2)
        self.assertTrue(all(row["video_id"] == "first"
                            for row in self.search(project_id="first", offset=2)["results"]))
        self.assertEqual(self.search(project_id="missing")["total"], 0)
        self.assertEqual(self.client.get("/library/search",
                         params={"q": "gradient", "project_id": "../first"}).status_code, 400)

    def test_pagination_filters_and_live_file_changes(self):
        all_rows = self.search()["results"]
        first = self.search(limit=2)
        second = self.search(offset=2, limit=2)
        self.assertEqual(first["total"], len(all_rows))
        self.assertEqual(first["results"] + second["results"], all_rows[:4])
        self.assertTrue(all(row["kind"] == "section" for row in self.search(kind="section")["results"]))
        self.write(self.TRANSCRIPTS_DIR / "second_uploaded.json", [{"start": 7, "text": "Freshly edited keyword"}])
        self.assertEqual(self.search("Freshly edited")["results"][0]["timestamp"], 7)
        (self.VIDEO_DIR / "second.webm").unlink()
        self.assertEqual(self.search("Freshly edited")["total"], 0)

    def test_bad_files_are_explicitly_reported_and_other_results_remain_available(self):
        (self.TRANSCRIPTS_DIR / "second_uploaded.json").write_text("{broken", encoding="utf-8")
        self.write(self.TRANSCRIPTS_DIR / "versions" / "first" / "t-old.json",
                   {"transcript": None, "chapters": [{"title": "gradient", "sections": 2}]})
        with self.assertLogs("library_search", level="WARNING"):
            result = self.search()
        self.assertTrue(result["results"])
        self.assertGreaterEqual(len(result["warnings"]), 3)

    def test_query_validation_empty_results_and_snippets(self):
        for params in ({}, {"q": ""}, {"q": " "}, {"q": "x" * 201}, {"q": "x", "kind": "unknown"},
                       {"q": "x", "offset": -1}, {"q": "x", "limit": 101}):
            with self.subTest(params=params):
                self.assertIn(self.client.get("/library/search", params=params).status_code, (400, 422))
        self.assertEqual(self.search("does not occur")["total"], 0)
        self.write(self.TRANSCRIPTS_DIR / "second_uploaded.json",
                   [{"start": 3, "text": "a" * 1000 + "needle" + "z" * 1000}])
        result = self.search("needle")["results"][0]
        self.assertIn("needle", result["snippet"])
        self.assertLess(len(result["snippet"]), 300)

    def test_legacy_caption_files_and_grouped_outlines_are_searchable(self):
        self.write(self.TRANSCRIPTS_DIR / "second.json", [{"start": 1, "text": "Legacy saved phrase"}])
        self.write(self.SUMMARIES_DIR / "second.json", [[{"timestamp": "00:02", "title": "Legacy topic"}]])
        rows = self.search("Legacy")["results"]
        self.assertEqual({row["kind"] for row in rows}, {"transcript", "chapter"})
        self.assertEqual({row["timestamp"] for row in rows}, {1, 2})

    def test_search_is_read_only_and_does_not_open_unvalidated_version_paths(self):
        paths = [path for path in self.root.rglob("*") if path.is_file()]
        original = {path: path.read_bytes() for path in paths}
        self.search()
        self.assertEqual(original, {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
        self.write(self.TRANSCRIPTS_DIR / "versions" / "second" / "index.json",
                   [{"id": "../../outside"}])
        self.assertEqual(self.search("outside")["total"], 0)
