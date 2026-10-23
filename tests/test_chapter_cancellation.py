import ast
import asyncio
from pathlib import Path
import re
from types import SimpleNamespace
import unittest


class ChapterCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_cancels_pending_generation_without_saving_and_cleans_registry(self):
        entered = asyncio.Event()
        saved = []
        async def generate(*args, **kwargs):
            entered.set()
            await asyncio.sleep(60)
            saved.append(True)
        source = ast.parse((Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8"))
        nodes = [node for node in source.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name in ("generate_summary", "cancel_summary")]
        for node in nodes:
            node.decorator_list = []
        namespace = {"Request": object, "asyncio": asyncio, "re": re, "summary_generation_tasks": {},
                     "JSONResponse": lambda data: data, "summary_processor": SimpleNamespace(generate_summary=generate)}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "<summary-routes>", "exec"), namespace)
        async def payload():
            return {"video_id": "video", "basis": "topics"}
        task = asyncio.create_task(namespace["generate_summary"](SimpleNamespace(json=payload)))
        await entered.wait()
        duplicate = await namespace["generate_summary"](SimpleNamespace(json=payload))
        self.assertIn("already running", duplicate["error"])
        self.assertTrue((await namespace["cancel_summary"]("video"))["success"])
        self.assertTrue((await task)["cancelled"])
        self.assertFalse(saved)
        self.assertEqual(namespace["summary_generation_tasks"], {})
        self.assertFalse((await namespace["cancel_summary"]("video"))["success"])
