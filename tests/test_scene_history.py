import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from processors import scene_history


class SlideHistoryTests(unittest.TestCase):
    def test_archive_preserves_images_metadata_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.multiple(scene_history, SCENES_DIR=root / "scenes",
                                THUMBNAILS_DIR=root / "thumbs", FULLSIZE_IMAGES_DIR=root / "images"):
                scene_history.SCENES_DIR.mkdir()
                for directory in (scene_history.THUMBNAILS_DIR, scene_history.FULLSIZE_IMAGES_DIR):
                    (directory / "video").mkdir(parents=True)
                    (directory / "video" / "0.jpg").write_bytes(b"previous slide")
                source = scene_history.SCENES_DIR / "video.json"
                source.write_text(json.dumps([{"time_seconds": 0, "timestamp": "00:00"}]))
                scene_history.archive("video")
                scene_history.archive("video")
                sets = scene_history.list_sets("video", include_current=False)
                self.assertEqual(len(sets), 1)
                for directory in (scene_history.THUMBNAILS_DIR, scene_history.FULLSIZE_IMAGES_DIR):
                    (directory / "video" / "0.jpg").write_bytes(b"new slide")
                snapshot = scene_history.SCENES_DIR / "history" / sets[0]["id"]
                self.assertEqual((snapshot / "t0.jpg").read_bytes(), b"previous slide")
                self.assertEqual((snapshot / "f0.jpg").read_bytes(), b"previous slide")
                self.assertIn("/static/scenes/history/", sets[0]["scenes"][0]["thumbnail"])
                source.unlink()
                self.assertEqual(len(scene_history.list_sets("video")), 1,
                                 "Previous slides remain available during a new run")
                self.assertEqual(scene_history.list_sets("other"), [])

    def test_missing_images_fail_before_existing_slides_are_replaced(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(scene_history, "SCENES_DIR", Path(temporary)):
            source = Path(temporary) / "video.json"
            source.write_text('[{"time_seconds":0}]')
            with self.assertRaisesRegex(ValueError, "missing"):
                scene_history.archive("video")
            self.assertTrue(source.is_file())
            self.assertEqual(list((Path(temporary) / "history").glob("*/snapshot.json")), [])
            with self.assertRaisesRegex(ValueError, "Invalid video"):
                scene_history.list_sets("../video")
