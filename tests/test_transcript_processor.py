import asyncio
import ast
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

fastapi_module = sys.modules.setdefault("fastapi", ModuleType("fastapi"))
fastapi_responses_module = sys.modules.setdefault(
    "fastapi.responses", ModuleType("fastapi.responses")
)

class FakeJSONResponse:
    def __init__(self, content):
        self.content = content


fastapi_responses_module.JSONResponse = FakeJSONResponse
fastapi_module.responses = fastapi_responses_module

youtube_module = ModuleType("youtube_transcript_api")
youtube_module.YouTubeTranscriptApi = object
sys.modules.setdefault("youtube_transcript_api", youtube_module)

transcribe_module = ModuleType("transcribe")
transcribe_module.transcribe_audio = lambda *args, **kwargs: ()
transcribe_module.WHISPER_MODELS = ("turbo", "large-v3", "medium", "small", "base")
transcribe_module.get_whisper_device_config = lambda: ("cuda", "float16")
transcribe_module.describe_transcription_method = lambda device: "batched (batch size 16)"
sys.modules.setdefault("transcribe", transcribe_module)

from processors import transcript_processor as transcript_module
from processors.transcript_processor import TranscriptProcessor


class TranscriptProcessorReuseTests(unittest.TestCase):
    def test_speaker_click_reconnects_to_running_job_when_transcript_is_backed_up(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(TranscriptProcessor, "_terminate_whisper_process") as terminate:
            root = Path(directory)
            (root / "vid_whisper_before_speakers.json").write_text('[{"start":0,"text":"Existing"}]')
            (root / "vid_whisper_progress.txt").write_text("100")
            response = asyncio.run(TranscriptProcessor().generate_whisper_transcript(
                "vid", mock.Mock(), speakers_only=True, force=True))
            self.assertTrue(response.content["success"])
            self.assertEqual(response.content["status"], "in_progress")
            terminate.assert_not_called()
            self.assertTrue((root / "vid_whisper_before_speakers.json").exists())

    def test_cancel_restores_previous_transcript_and_clears_progress(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(TranscriptProcessor, "_terminate_whisper_process", return_value=True):
            root = Path(directory)
            segments = [{"text": "Previous", "start": 0}]
            (root / "vid_whisper_before_speakers.json").write_text(json.dumps(segments), encoding="utf-8")
            (root / "vid_whisper_progress.txt").write_text("100", encoding="utf-8")
            response = asyncio.run(TranscriptProcessor().cancel_whisper_generation("vid"))
            self.assertTrue(response.content["success"])
            self.assertEqual(response.content["transcript"], segments)
            self.assertFalse((root / "vid_whisper_progress.txt").exists())

    def test_interrupted_speaker_job_restores_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            working_dir = Path(directory)
            with mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", working_dir):
                segments = [{"start": 0, "duration": 1, "text": "Hallo"}]
                (working_dir / "vid_whisper_before_speakers.json").write_text(json.dumps(segments), encoding="utf-8")
                (working_dir / "vid_whisper_progress.txt").write_text("100", encoding="utf-8")
                (working_dir / "kept_whisper.json").write_text("[]", encoding="utf-8")
                (working_dir / "kept_whisper_before_speakers.json").write_text("[]", encoding="utf-8")
                TranscriptProcessor().restore_interrupted_speaker_jobs()
                self.assertEqual(json.loads((working_dir / "vid_whisper.json").read_text(encoding="utf-8")), segments)
                self.assertFalse((working_dir / "vid_whisper_progress.txt").exists())
                self.assertFalse((working_dir / "vid_whisper_before_speakers.json").exists())
                self.assertFalse((working_dir / "kept_whisper_before_speakers.json").exists())

    def test_constructing_worker_preserves_active_speaker_job(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)):
            working_dir = Path(directory)
            backup = working_dir / "vid_whisper_before_speakers.json"
            progress = working_dir / "vid_whisper_progress.txt"
            backup.write_text('[{"text": "Hallo"}]', encoding="utf-8")
            progress.write_text("100", encoding="utf-8")
            with mock.patch.object(TranscriptProcessor, "_process_whisper_transcript_sync") as process:
                transcript_module._run_whisper_worker(
                    "vid", "video.mp4", str(working_dir / "vid_whisper.json"),
                    True, [{"text": "Hallo"}], speaker_mode="fast",
                )
                self.assertEqual(process.call_args.args[-1], "fast")
            self.assertTrue(backup.exists())
            self.assertEqual(progress.read_text(), "100")
            self.assertFalse((working_dir / "vid_whisper.json").exists())

    def test_heartbeat_does_not_recreate_completed_job_marker(self):
        class StopAfterOneHeartbeat:
            def wait(self, timeout):
                return False

        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)):
            TranscriptProcessor()._heartbeat_whisper_job("video", StopAfterOneHeartbeat())
            self.assertFalse((Path(directory) / "video_whisper_progress.txt").exists())

    def test_status_handles_progress_removed_after_existence_check(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)):
            progress = str(Path(directory) / "video_whisper_progress.txt")
            original_exists = os.path.exists
            checks = []

            def exists(path):
                if str(path) == progress:
                    checks.append(path)
                    return len(checks) == 1
                return original_exists(path)

            with mock.patch.object(transcript_module.os.path, "exists", side_effect=exists):
                response = asyncio.run(TranscriptProcessor().get_whisper_status("video"))
            self.assertEqual(response.content["status"], "queued")
            self.assertTrue(response.content["success"])

    def test_heartbeat_refreshes_progress_marker(self):
        class StopAfterOneHeartbeat:
            def __init__(self):
                self.calls = 0

            def wait(self, timeout):
                self.calls += 1
                return self.calls > 1

        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            working_dir = Path(directory)
            transcript_module.TRANSCRIPTS_DIR = working_dir
            try:
                progress_path = working_dir / "video_whisper_progress.txt"
                progress_path.write_text("0", encoding="utf-8")
                old_time = time.time() - 120
                os.utime(progress_path, (old_time, old_time))
                processor = TranscriptProcessor()

                processor._heartbeat_whisper_job(
                    "video", StopAfterOneHeartbeat()
                )

                self.assertLess(time.time() - progress_path.stat().st_mtime, 5)
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir

    def test_forced_retry_reclaims_an_old_progress_marker(self):
        class BackgroundTasks:
            def __init__(self):
                self.tasks = []

            def add_task(self, function, *args):
                self.tasks.append((function, args))

        with tempfile.TemporaryDirectory() as directory:
            original_video_dir = transcript_module.VIDEO_DIR
            original_transcript_dir = transcript_module.TRANSCRIPTS_DIR
            working_dir = Path(directory)
            transcript_module.VIDEO_DIR = working_dir
            transcript_module.TRANSCRIPTS_DIR = working_dir
            try:
                (working_dir / "video.mp4").write_bytes(b"video")
                progress_path = working_dir / "video_whisper_progress.txt"
                progress_path.write_text("0", encoding="utf-8")
                old_time = time.time() - 120
                os.utime(progress_path, (old_time, old_time))
                background_tasks = BackgroundTasks()
                processor = TranscriptProcessor()
                processor.manual_retry_stale_seconds = 90

                response = asyncio.run(
                    processor.generate_whisper_transcript(
                        "video", background_tasks, force=True
                    )
                )

                self.assertEqual(response.content["phase"], "starting")
                self.assertEqual(len(background_tasks.tasks), 1)
                self.assertLess(time.time() - progress_path.stat().st_mtime, 5)
            finally:
                transcript_module.VIDEO_DIR = original_video_dir
                transcript_module.TRANSCRIPTS_DIR = original_transcript_dir

    def test_matching_model_and_prompt_allow_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            transcript_module.TRANSCRIPTS_DIR = Path(directory)
            try:
                metadata_path = Path(directory) / "video_whisper_meta.json"
                metadata_path.write_text(
                    json.dumps({
                        "model": "turbo",
                    }),
                    encoding="utf-8",
                )
                processor = TranscriptProcessor()

                self.assertTrue(
                    processor._can_reuse_whisper_transcript("video")
                )
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir

    def test_existing_transcript_skips_asr_and_runs_diarization(self):
        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            original_transcribe = transcript_module.transcribe_audio
            transcript_module.TRANSCRIPTS_DIR = Path(directory)
            transcript_module.transcribe_audio = self._unexpected_transcription
            try:
                processor = TranscriptProcessor()
                processor.apply_diarization = mock.Mock(side_effect=lambda path, transcript, **kwargs: (
                    [{**item, "speaker": "SPEAKER_00"} for item in transcript],
                    {"SPEAKER_00": "Speaker 00"},
                ))
                output_path = Path(directory) / "video_whisper.json"
                existing = [{"text": "Hello", "start": 0, "duration": 1}]
                (Path(directory) / "video_whisper_progress.txt").write_text(
                    "100", encoding="utf-8"
                )

                processor._process_whisper_transcript_sync(
                    "video",
                    "video.mp4",
                    str(output_path),
                    diarization=True,
                    existing_transcript=existing,
                    speaker_mode="fast",
                )

                result = json.loads(output_path.read_text(encoding="utf-8"))
                self.assertEqual(result[0]["speaker"], "SPEAKER_00")
                self.assertEqual(
                    [{key: value for key, value in item.items() if key != "speaker"} for item in result],
                    existing,
                )
                self.assertEqual(processor.apply_diarization.call_args.kwargs["speaker_mode"], "fast")
                self.assertEqual(processor._public_whisper_metadata("video")["speaker_mode"], "fast")
                self.assertFalse(
                    (Path(directory) / "video_whisper_progress.txt").exists()
                )
                self.assertFalse(
                    (Path(directory) / "video_whisper_phase.txt").exists()
                )
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir
                transcript_module.transcribe_audio = original_transcribe

    @staticmethod
    def _unexpected_transcription(*args, **kwargs):
        raise AssertionError("ASR should not run when reusing a transcript")

    def test_selected_model_is_used_and_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            original_transcribe = transcript_module.transcribe_audio
            transcript_module.TRANSCRIPTS_DIR = Path(directory)
            calls = []

            def fake_transcribe(path, model_name="turbo", prompt=None, on_step=None):
                calls.append((model_name, prompt))
                on_step("Loading Whisper")
                yield "1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n", 100

            transcript_module.transcribe_audio = fake_transcribe
            try:
                processor = TranscriptProcessor()
                output_path = Path(directory) / "video_whisper.json"
                processor._process_whisper_transcript_sync(
                    "video", "video.mp4", str(output_path), model="large-v3",
                    prompt="SAP lecture",
                )

                metadata = processor._public_whisper_metadata("video")
                self.assertEqual(calls, [("large-v3", "SAP lecture")])
                steps, elapsed = transcript_module.read_transcript_steps("video")
                messages = [step["message"] for step in steps]
                self.assertIn("Loading Whisper", messages)
                self.assertTrue(any(m.startswith("Transcription finished") for m in messages))
                self.assertTrue(any(m.startswith("Saving the transcript") for m in messages))
                self.assertIsNotNone(elapsed)
                self.assertEqual(metadata["model"], "large-v3")
                self.assertEqual(metadata["prompt"], "SAP lecture")
                self.assertEqual(metadata["device"], "cuda")
                self.assertFalse(metadata["diarization"])
                self.assertTrue(
                    processor._can_reuse_whisper_transcript("video", "large-v3", "SAP lecture")
                )
                self.assertFalse(
                    processor._can_reuse_whisper_transcript("video", "large-v3")
                )
                self.assertFalse(
                    processor._can_reuse_whisper_transcript("video", "turbo", "SAP lecture")
                )
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir
                transcript_module.transcribe_audio = original_transcribe

    def test_unsupported_model_is_rejected(self):
        response = asyncio.run(
            TranscriptProcessor().generate_whisper_transcript(
                "video", None, model="unknown"
            )
        )
        self.assertFalse(response.content["success"])

    def test_invalid_speaker_mode_does_not_stop_a_job(self):
        processor = TranscriptProcessor()
        with mock.patch.object(processor, "_terminate_whisper_process") as terminate:
            for mode in ("quick", None, [], True):
                response = asyncio.run(processor.generate_whisper_transcript(
                    "video", None, force=True, speaker_mode=mode,
                ))
                self.assertFalse(response.content["success"])
                self.assertIn("Unsupported speaker mode", response.content["error"])
            terminate.assert_not_called()

    def test_speaker_mode_is_queued_with_the_existing_transcript(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(transcript_module, "VIDEO_DIR", Path(directory)):
            root = Path(directory)
            (root / "video.mp4").write_bytes(b"video")
            (root / "video_whisper.json").write_text('[{"text":"Hello","start":0,"duration":1}]')
            (root / "video_whisper_meta.json").write_text('{"model":"turbo"}')
            tasks = mock.Mock()
            result = asyncio.run(TranscriptProcessor().generate_whisper_transcript(
                "video", tasks, speakers_only=True, speaker_mode="fast",
            ))
            self.assertTrue(result.content["success"])
            self.assertEqual(tasks.add_task.call_args.args[-1], "fast")
            self.assertEqual(tasks.add_task.call_args.args[5][0]["text"], "Hello")

    def test_online_model_without_key_is_rejected(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            response = asyncio.run(
                TranscriptProcessor().generate_whisper_transcript(
                    "video", None, model="groq:whisper-large-v3-turbo"
                )
            )
        self.assertFalse(response.content["success"])
        self.assertIn("GROQ_API_KEY", response.content["error"])

    def test_online_model_is_used_and_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            transcript_module.TRANSCRIPTS_DIR = Path(directory)

            def fake_cloud(path, model, prompt=None, on_step=None):
                yield [{"text": "Hallo.", "start": 0.0, "duration": 1.5}], 100.0

            try:
                with mock.patch.object(transcript_module, "transcribe_audio_cloud", fake_cloud), \
                        mock.patch.object(transcript_module, "transcribe_audio",
                                          self._unexpected_transcription):
                    processor = TranscriptProcessor()
                    output_path = Path(directory) / "video_whisper.json"
                    processor._process_whisper_transcript_sync(
                        "video", "video.mp4", str(output_path),
                        model="gemini:gemini-2.5-flash",
                    )
                    metadata = processor._public_whisper_metadata("video")
                    transcript = processor._read_transcript("video")
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir

        self.assertEqual(transcript[0]["text"], "Hallo.")
        self.assertEqual(metadata["model"], "gemini:gemini-2.5-flash")
        self.assertEqual(metadata["device"], "cloud")
        self.assertIn("Gemini API", metadata["transcription_method"])


class TranscriptProcessorIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_speaker_mode_is_forwarded_to_spawned_worker(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(transcript_module.multiprocessing, "get_context") as context:
            context.return_value.Process.return_value.exitcode = 0
            await TranscriptProcessor().process_whisper_transcript(
                "video", "video.mp4", "transcript.json", speaker_mode="fast",
            )
            arguments = context.return_value.Process.call_args.kwargs
            self.assertIs(arguments["target"], transcript_module._run_whisper_worker)
            self.assertEqual(arguments["args"][-1], "fast")

    async def test_native_worker_crash_becomes_status_error(self):
        class FailedProcess:
            exitcode = -9

            def start(self):
                pass

            def join(self, timeout=None):
                pass

            def is_alive(self):
                return False

        class ProcessContext:
            def Process(self, **kwargs):
                return FailedProcess()

        with tempfile.TemporaryDirectory() as directory:
            original_dir = transcript_module.TRANSCRIPTS_DIR
            original_get_context = transcript_module.multiprocessing.get_context
            transcript_module.TRANSCRIPTS_DIR = Path(directory)
            transcript_module.multiprocessing.get_context = (
                lambda method: ProcessContext()
            )
            try:
                progress_path = Path(directory) / "video_whisper_progress.txt"
                progress_path.write_text("0", encoding="utf-8")
                processor = TranscriptProcessor()

                await processor.process_whisper_transcript(
                    "video", "video.mp4", "transcript.json"
                )
                response = await processor.get_whisper_status("video")

                self.assertEqual(response.content["status"], "error")
                self.assertIn("exit code -9", response.content["error"])
                self.assertFalse(progress_path.exists())
            finally:
                transcript_module.TRANSCRIPTS_DIR = original_dir
                transcript_module.multiprocessing.get_context = original_get_context

    def test_forced_retry_can_terminate_active_worker(self):
        class RunningProcess:
            def __init__(self):
                self.alive = True
                self.terminated = False

            def is_alive(self):
                return self.alive

            def terminate(self):
                self.terminated = True
                self.alive = False

            def join(self, timeout=None):
                pass

        process = RunningProcess()
        transcript_module._ACTIVE_WHISPER_PROCESSES["video"] = process

        TranscriptProcessor._terminate_whisper_process("video")

        self.assertTrue(process.terminated)
        self.assertNotIn(
            "video", transcript_module._ACTIVE_WHISPER_PROCESSES
        )

    async def test_replaced_worker_cannot_overwrite_new_job_status(self):
        class ReplacedProcess:
            exitcode = -15

            def start(self):
                pass

            def join(self):
                TranscriptProcessor._terminate_whisper_process("video")
                transcript_module._ACTIVE_WHISPER_PROCESSES["video"] = replacement

            def is_alive(self):
                return False

        replacement = object()
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(transcript_module.multiprocessing, "get_context") as context:
            context.return_value.Process.return_value = ReplacedProcess()
            progress = Path(directory) / "video_whisper_progress.txt"
            progress.write_text("42", encoding="utf-8")
            processor = TranscriptProcessor()
            processor._write_whisper_phase("video", "transcribing")
            try:
                await processor.process_whisper_transcript("video", "video.mp4", "output.json")
                self.assertEqual(progress.read_text(), "42")
                self.assertTrue((Path(directory) / "video_whisper_phase.txt").exists())
                self.assertFalse((Path(directory) / "video_whisper_error.txt").exists())
                self.assertIs(transcript_module._ACTIVE_WHISPER_PROCESSES["video"], replacement)
            finally:
                transcript_module._ACTIVE_WHISPER_PROCESSES.pop("video", None)

    async def test_forced_retry_starts_immediately_after_terminating_worker(self):
        class BackgroundTasks:
            def __init__(self):
                self.tasks = []

            def add_task(self, *args):
                self.tasks.append(args)

        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "VIDEO_DIR", Path(directory)), \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)):
            (Path(directory) / "video.mp4").write_bytes(b"video")
            progress = Path(directory) / "video_whisper_progress.txt"
            progress.write_text("42", encoding="utf-8")
            process = mock.Mock()
            process.is_alive.side_effect = [True, False]
            transcript_module._ACTIVE_WHISPER_PROCESSES["video"] = process
            tasks = BackgroundTasks()
            response = await TranscriptProcessor().generate_whisper_transcript(
                "video", tasks, force=True
            )
            process.terminate.assert_called_once()
            self.assertEqual(len(tasks.tasks), 1)
            self.assertEqual(response.content["phase"], "starting")
            self.assertEqual(progress.read_text(), "0")

    async def test_worker_start_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)), \
                mock.patch.object(transcript_module.multiprocessing, "get_context") as context:
            context.return_value.Process.return_value.start.side_effect = OSError(
                "Cannot start the worker"
            )
            await TranscriptProcessor().process_whisper_transcript(
                "video", "video.mp4", "output.json"
            )
            message = (Path(directory) / "video_whisper_error.txt").read_text()
            self.assertIn("Cannot start the worker", message)
            self.assertNotIn("video", transcript_module._ACTIVE_WHISPER_PROCESSES)

    def test_external_sigterm_has_specific_guidance(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(transcript_module, "TRANSCRIPTS_DIR", Path(directory)):
            TranscriptProcessor()._record_whisper_process_failure("video", -15)
            message = (Path(directory) / "video_whisper_error.txt").read_text()
            self.assertIn("SIGTERM", message)
            self.assertIn("restarted", message)


class HuggingFaceTokenTests(unittest.TestCase):
    def setUp(self):
        self.saved = {
            name: os.environ.pop(name, None)
            for name in ("HUGGINGFACE_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")
        }

    def tearDown(self):
        for name, value in self.saved.items():
            os.environ.pop(name, None)
            if value is not None:
                os.environ[name] = value

    def test_hf_token_environment_variable_is_detected(self):
        os.environ["HF_TOKEN"] = " hf_example "
        self.assertEqual(transcript_module.get_huggingface_token(), "hf_example")

    def test_saved_hub_login_is_used_when_environment_is_empty(self):
        hub_module = ModuleType("huggingface_hub")
        hub_module.get_token = lambda: "hf_saved"
        original = sys.modules.get("huggingface_hub")
        sys.modules["huggingface_hub"] = hub_module
        try:
            self.assertEqual(transcript_module.get_huggingface_token(), "hf_saved")
        finally:
            if original is None:
                sys.modules.pop("huggingface_hub", None)
            else:
                sys.modules["huggingface_hub"] = original


class PyannoteCompatibilityTests(unittest.TestCase):
    def test_fast_mode_changes_actual_inference_step_without_gaps(self):
        for mode, expected_step in (("standard", 1.0), ("fast", 5.0)):
            with self.subTest(mode=mode):
                inference = SimpleNamespace(step=1.0, duration=10.0)
                pipeline = mock.Mock(
                    _segmentation=inference, segmentation_step=0.1, embedding_batch_size=32,
                )
                torch_module = ModuleType("torch")
                torch_module.cuda = mock.Mock()
                torch_module.cuda.is_available.return_value = False
                processor = TranscriptProcessor()
                steps = []
                with mock.patch.dict(sys.modules, {"torch": torch_module}), \
                        mock.patch.object(processor, "_load_pyannote_pipeline", return_value=pipeline), \
                        mock.patch.object(processor, "_load_audio_waveform", return_value="full audio"):
                    processor._run_pyannote(object(), "hf", "video.mp4", steps.append, speaker_mode=mode)
                self.assertEqual(inference.step, expected_step)
                self.assertEqual(pipeline.segmentation_step, expected_step / inference.duration)
                self.assertLessEqual(inference.step, inference.duration)
                self.assertEqual(pipeline.call_args.args, ("full audio",))
                self.assertEqual(any("short speaker changes may be less precise" in step for step in steps),
                                 mode == "fast")

    def test_invalid_mode_is_rejected_before_model_loading(self):
        processor = TranscriptProcessor()
        with mock.patch.object(processor, "_load_pyannote_pipeline") as load:
            with self.assertRaisesRegex(ValueError, "Unsupported speaker mode"):
                processor._run_pyannote(object(), "hf", "video.mp4", speaker_mode="quick")
            load.assert_not_called()

    def test_generate_route_passes_speaker_mode_and_defaults_to_standard(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        route = next(node for node in tree.body
                     if isinstance(node, ast.AsyncFunctionDef) and node.name == "generate_whisper_transcript")
        route.decorator_list = []
        processor = mock.Mock()
        processor.generate_whisper_transcript = mock.AsyncMock(return_value="response")
        namespace = {
            "Request": object, "BackgroundTasks": object,
            "json": json, "transcript_processor": processor,
        }
        exec(compile(ast.Module(body=[route], type_ignores=[]), str(source), "exec"), namespace)
        for options, expected in (({"speakers_only": True, "speaker_mode": "fast"}, "fast"), ({}, "standard")):
            request = mock.Mock(json=mock.AsyncMock(return_value=options))
            result = asyncio.run(namespace["generate_whisper_transcript"]("video", request, object()))
            self.assertEqual(result, "response")
            self.assertEqual(processor.generate_whisper_transcript.call_args.kwargs["speaker_mode"], expected)

    def test_cpu_embedding_batches_are_bounded_without_changing_gpu_batches(self):
        for gpu, configured, expected in (
            (False, 32, 4), (False, 2, 2), (True, 32, 32),
        ):
            with self.subTest(gpu=gpu, configured=configured):
                torch_module = ModuleType("torch")
                torch_module.cuda = mock.Mock()
                torch_module.cuda.is_available.return_value = gpu
                torch_module.device = mock.Mock(return_value="cuda")
                annotation = object()
                pipeline = mock.Mock(embedding_batch_size=configured)

                def detect(audio, hook):
                    self.assertEqual(audio, "decoded audio")
                    hook("embeddings", total=8, completed=4)
                    return type("Result", (), {"speaker_diarization": annotation})()

                pipeline.side_effect = detect
                steps = []
                processor = TranscriptProcessor()
                with mock.patch.dict(sys.modules, {"torch": torch_module}), \
                        mock.patch.object(processor, "_load_pyannote_pipeline", return_value=pipeline), \
                        mock.patch.object(processor, "_load_audio_waveform", return_value="decoded audio"):
                    result = processor._run_pyannote(object(), "hf", "video.mp4", steps.append)
                self.assertIs(result, annotation)
                self.assertEqual(pipeline.embedding_batch_size, expected)
                self.assertIn(f"Speaker embedding batch size: {expected}", steps)
                self.assertIn("Detecting speakers: embeddings 50% (4/8 batches)", steps)
                if gpu:
                    pipeline.to.assert_called_once_with("cuda")
                else:
                    pipeline.to.assert_not_called()

    def test_uses_token_argument_for_pyannote_4(self):
        calls = []

        class Pipeline4:
            @staticmethod
            def from_pretrained(name, token=None):
                calls.append((name, token))
                return "pipeline"

        self.assertEqual(
            TranscriptProcessor._load_pyannote_pipeline(Pipeline4, "hf"), "pipeline"
        )
        self.assertEqual(calls, [("pyannote/speaker-diarization-3.1", "hf")])

    def test_falls_back_to_use_auth_token_for_pyannote_3(self):
        class Pipeline3:
            @staticmethod
            def from_pretrained(name, use_auth_token=None):
                return f"{name}:{use_auth_token}"

        self.assertEqual(
            TranscriptProcessor._load_pyannote_pipeline(Pipeline3, "hf"),
            "pyannote/speaker-diarization-3.1:hf",
        )


if __name__ == "__main__":
    unittest.main()
