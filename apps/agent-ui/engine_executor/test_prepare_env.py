"""Tests for runner.prepare_env — immutable per-commit checkout (see docs/parallel-execution.md §3).

Properties verified:
  1. Same (url, branch) with an unchanged remote => re-run reuses the SAME
     immutable commit directory, with ZERO git re-pull (marker hit).
  2. A freshly pushed commit => ls-remote resolves a DIFFERENT sha => a
     DIFFERENT directory, so new code is picked up (never runs stale code).
  3. An optional ``git_ref`` pins to a branch/tag and lands in a directory
     keyed by that ref's commit, isolated from the branch tip.
  4. Local paths are used directly (no clone, no sync).
  5. A missing branch raises on clone (never silently falls back).
  6. Concurrent prepare_env on the SAME key neither corrupts nor races
     (separate temp clones + atomic promote).

Run with:
    python3 test_prepare_env.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import runner  # noqa: E402


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", repo, *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _read_flag(root):
    with open(os.path.join(root, "flag.txt")) as f:
        return f.read()


def _commit(src, content, msg):
    with open(os.path.join(src, "flag.txt"), "w") as f:
        f.write(content)
    _git(src, "add", ".")
    _git(src, "commit", "-q", "-m", msg)


class PrepareEnvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="prepenv-")
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        self.src = os.path.join(self.tmp, "src")
        os.makedirs(self.src)
        _git(self.src, "init", "-q")
        _git(self.src, "checkout", "-b", "master")
        _git(self.src, "config", "user.email", "t@t")
        _git(self.src, "config", "user.name", "t")
        _commit(self.src, "v1", "v1")
        self.url = "file://" + self.src

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_same_commit_reused_without_repull(self):
        root1 = runner.prepare_env(self.url, "master", self.cache)
        self.assertEqual(_read_flag(root1), "v1")
        self.assertTrue(os.path.exists(os.path.join(root1, ".claw-fetched")))

        logs = []
        root2 = runner.prepare_env(
            self.url, "master", self.cache, log_fn=lambda k, m: logs.append((k, m))
        )
        # Same immutable commit dir reused — no clone, just a marker hit.
        self.assertEqual(root1, root2)
        self.assertEqual(_read_flag(root2), "v1")
        self.assertNotIn("克隆组件", "".join(m for _, m in logs))

    def test_new_commit_goes_to_new_directory(self):
        root1 = runner.prepare_env(self.url, "master", self.cache)
        self.assertEqual(_read_flag(root1), "v1")

        _commit(self.src, "v2", "v2")

        root2 = runner.prepare_env(self.url, "master", self.cache)
        # New commit => different (immutable) directory, containing the new code.
        self.assertNotEqual(root1, root2)
        self.assertEqual(_read_flag(root2), "v2")
        # The old directory still holds the old code (immutable, not overwritten).
        self.assertEqual(_read_flag(root1), "v1")

    def test_git_ref_pin_to_branch(self):
        _git(self.src, "branch", "release")
        _commit(self.src, "v2", "v2")

        root_pinned = runner.prepare_env(self.url, "master", self.cache, git_ref="release")
        self.assertEqual(_read_flag(root_pinned), "v1")

        root_master = runner.prepare_env(self.url, "master", self.cache)
        self.assertEqual(_read_flag(root_master), "v2")

        # Different ref => different cache slot (key folds in git_ref).
        self.assertNotEqual(root_pinned, root_master)

    def test_local_path_is_used_directly(self):
        logs = []
        root = runner.prepare_env(
            self.src, "master", self.cache, log_fn=lambda k, m: logs.append((k, m))
        )
        self.assertEqual(root, self.src)
        self.assertEqual(_read_flag(root), "v1")
        self.assertNotIn("克隆组件", "".join(m for _, m in logs))

    def test_missing_branch_fails_on_clone(self):
        with self.assertRaises(RuntimeError):
            runner.prepare_env(self.url, "does-not-exist", self.cache)

    def test_concurrent_same_key_no_corruption(self):
        n = 6
        barrier = threading.Barrier(n)
        results = {}

        def worker(i):
            barrier.wait()
            return runner.prepare_env(self.url, "master", self.cache)

        with ThreadPoolExecutor(max_workers=n) as ex:
            futures = [ex.submit(worker, i) for i in range(n)]
            for i, fut in enumerate(futures):
                results[i] = fut.result()  # must not raise

        # All resolve to the SAME immutable commit directory.
        first = results[0]
        for r in results.values():
            self.assertEqual(r, first)
        # The directory is intact (marker + expected file, no corruption).
        self.assertTrue(os.path.exists(os.path.join(first, ".claw-fetched")))
        self.assertEqual(_read_flag(first), "v1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
