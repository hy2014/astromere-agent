"""Tests for runner.prepare_env — specifically the "code change detection" behaviour.

These cover the two properties that make "edit code -> push -> run dag" work:

  1. A cached clone is **re-pulled** on the next prepare_env call, so a freshly
     pushed commit is picked up (never runs stale code).
  2. An optional ``git_ref`` pins the clone to a branch/tag and lands in a
     *different* cache directory, so the exact code that ran is reproducible.

Run with:
    python3 test_prepare_env.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

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


class PrepareEnvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="prepenv-")
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        self.src = os.path.join(self.tmp, "src")
        os.makedirs(self.src)
        _git(self.src, "init", "-q")
        # Pin the default branch name so tests do not depend on the system
        # git default (master vs main).
        _git(self.src, "checkout", "-b", "master")
        _git(self.src, "config", "user.email", "t@t")
        _git(self.src, "config", "user.name", "t")
        with open(os.path.join(self.src, "flag.txt"), "w") as f:
            f.write("v1")
        _git(self.src, "add", ".")
        _git(self.src, "commit", "-q", "-m", "v1")
        self.url = "file://" + self.src

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_repull_picks_up_new_commit(self):
        root1 = runner.prepare_env(self.url, "master", self.cache)
        self.assertEqual(_read_flag(root1), "v1")

        # Push a newer commit to the source repo.
        with open(os.path.join(self.src, "flag.txt"), "w") as f:
            f.write("v2")
        _git(self.src, "add", ".")
        _git(self.src, "commit", "-q", "-m", "v2")

        logs = []
        root2 = runner.prepare_env(
            self.url, "master", self.cache, log_fn=lambda k, m: logs.append((k, m))
        )
        # Same cache dir reused, but now contains the new code.
        self.assertEqual(root1, root2)
        self.assertEqual(_read_flag(root2), "v2")
        self.assertIn("re-pulling", "".join(m for _, m in logs))

    def test_git_ref_pin_to_branch(self):
        # Create a 'release' branch pinned at v1, then advance master to v2.
        _git(self.src, "branch", "release")
        with open(os.path.join(self.src, "flag.txt"), "w") as f:
            f.write("v2")
        _git(self.src, "add", ".")
        _git(self.src, "commit", "-q", "-m", "v2")

        root_pinned = runner.prepare_env(self.url, "master", self.cache, git_ref="release")
        self.assertEqual(_read_flag(root_pinned), "v1")

        root_master = runner.prepare_env(self.url, "master", self.cache)
        self.assertEqual(_read_flag(root_master), "v2")

        # Different ref => different cache directory.
        self.assertNotEqual(root_pinned, root_master)

    def test_local_path_is_used_directly(self):
        # A plain path is not cloned and never re-pulled.
        logs = []
        root = runner.prepare_env(self.src, "master", self.cache, log_fn=lambda k, m: logs.append((k, m)))
        self.assertEqual(root, self.src)
        self.assertEqual(_read_flag(root), "v1")
        self.assertNotIn("re-pulling", "".join(m for _, m in logs))

    def test_missing_branch_fails_on_clone(self):
        # Requesting a branch that does not exist must raise, never silently
        # fall back to the default branch.
        with self.assertRaises(RuntimeError):
            runner.prepare_env(self.url, "does-not-exist", self.cache)

    def test_missing_branch_fails_on_resync(self):
        # Cache hit (re-sync) when the branch has been deleted upstream: must
        # raise rather than re-clone/fall back to a different branch.
        runner.prepare_env(self.url, "master", self.cache)
        # Delete the branch from the source repo so it is no longer fetchable.
        _git(self.src, "branch", "-m", "master", "trunk")
        with self.assertRaises(RuntimeError):
            runner.prepare_env(self.url, "master", self.cache)


if __name__ == "__main__":
    unittest.main(verbosity=2)
