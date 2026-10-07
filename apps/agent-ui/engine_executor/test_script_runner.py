"""Tests for the built-in generic component ``global_components.script_runner``
and for ``runner.resolve_argv``.

Covers:
  1. resolve_argv: repo-local file passthrough (trimmed), the reserved ``@``
     keyword -> ``python -m ...`` argv (whitespace tolerant), unknown keyword
     fails loudly listing available entries, None / empty input.
  2. core.main full protocol, in-process: success with ScriptJob subclass and
     default class name, duck-typed class with a custom name, whitespace
     trimming, None result -> {}, routing keys stripped while other inputs are
     flattened through, PathLike/nested/tuple normalization, every protocol
     violation (missing/blank/wrong-typed routing params, import failure,
     missing class with a hint, non-class target, bad constructor, missing
     run(), business exception keeping its traceback, non-dict result, bad
     output keys, NaN/Infinity/unserializable values), malformed input
     (bad JSON / top-level non-object / missing env / unreadable file),
     missing output env, and atomic output writes.
  3. RunContext: platform-allocated dir wins and is created, fallback dir for
     standalone runs and unknown ports, invalid port names, env snapshot,
     stderr logging.
  4. ScriptJob base: input/ctx storage, output_dir/log forwarding, abstract run.
  5. End-to-end through runner.run_node: a business repo containing only a
     task class runs via the ``@global_components.script_runner`` keyword.

All examples use generic names only — the platform must stay ignorant of any
specific business project.

Run with:
    python3 test_script_runner.py
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "sdk"))

import runner  # noqa: E402
from global_components.script_runner import RunContext, ScriptJob  # noqa: E402
from global_components.script_runner import core as sr_core  # noqa: E402

ENV_KEYS = (
    "AGENT_UI_INPUT_PATH",
    "AGENT_UI_OUTPUT_PATH",
    "AGENT_UI_COMPONENT_ROOT",
    "AGENT_UI_OUTPUT_DATA_DIRS",
)

# --- Generic business-module sources (no project-specific information) ---

SUBCLASS_JOB = """
from pathlib import Path

from global_components.script_runner import ScriptJob


class Job(ScriptJob):
    def run(self):
        return {
            "echo": self.inputs["message"],
            "count": len(self.inputs["items"]),
            "ratio": 3.14,
            "enabled": True,
            "path": Path("/generic/output/data.parquet"),
            "nested": {"vals": (1, "two", 3.0), "deep": {"ok": True}},
        }
"""

DUCK_TYPED_JOB = """
class CustomTask:
    def __init__(self, inputs, ctx):
        self.inputs = inputs
        self.ctx = ctx

    def run(self):
        return {"got": self.inputs["value"]}
"""

RECORDS_INPUTS_JOB = """
from global_components.script_runner import ScriptJob


class Job(ScriptJob):
    def run(self):
        return {"keys": sorted(self.inputs.keys())}
"""

NONE_RESULT_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return None
"""

BAD_CONSTRUCTOR_JOB = """
class Job:
    def __init__(self):
        pass

    def run(self):
        return {}
"""

RAISING_CONSTRUCTOR_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        raise ValueError("constructor boom")

    def run(self):
        return {}
"""

NO_RUN_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass
"""

BUSINESS_EXCEPTION_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        raise RuntimeError("business boom")
"""

NON_DICT_RESULT_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return [1, 2, 3]
"""

NON_STRING_KEY_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {1: "x"}
"""

EMPTY_KEY_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {"": "x"}
"""

NAN_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {"x": float("nan")}
"""

INF_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {"x": float("inf")}
"""

UNSERIALIZABLE_JOB = """
class Job:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {"x": {1, 2}}
"""

OTHER_CLASS_ONLY = """
class Other:
    def __init__(self, inputs, ctx):
        pass

    def run(self):
        return {}


not_a_class = 42
"""

NOT_A_CLASS_JOB = """
Job = 42
"""

IMPORT_TIME_FAILURE = """
raise RuntimeError("import time boom")
"""

E2E_JOB = """
import csv
import os

from global_components.script_runner import ScriptJob


class Job(ScriptJob):
    def run(self):
        out_dir = self.output_dir("report")
        path = os.path.join(out_dir, "report.csv")
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "value"])
            writer.writerow([self.inputs["date"], 1])
        return {
            "report": {"path": path, "format": "csv"},
            "echo": self.inputs["date"],
        }
"""


class ResolveArgvTests(unittest.TestCase):
    PY = "/usr/bin/python3"

    def test_plain_file_passthrough(self):
        self.assertEqual(
            runner.resolve_argv(self.PY, "run.py"),
            [self.PY, "run.py"],
        )
        self.assertEqual(
            runner.resolve_argv(self.PY, "subdir/main.py"),
            [self.PY, "subdir/main.py"],
        )

    def test_plain_path_is_trimmed(self):
        # Pasted UI input may carry whitespace; a padded path must not reach
        # execvp verbatim.
        self.assertEqual(
            runner.resolve_argv(self.PY, "  run.py  "),
            [self.PY, "run.py"],
        )

    def test_builtin_keyword_resolves_to_module_argv(self):
        self.assertEqual(
            runner.resolve_argv(self.PY, "@global_components.script_runner"),
            [self.PY, "-m", "global_components.script_runner"],
        )

    def test_builtin_keyword_is_trimmed(self):
        self.assertEqual(
            runner.resolve_argv(self.PY, "  @global_components.script_runner \n"),
            [self.PY, "-m", "global_components.script_runner"],
        )

    def test_unknown_keyword_lists_available_entries(self):
        with self.assertRaises(ValueError) as ctx:
            runner.resolve_argv(self.PY, "@does.not.exist")
        message = str(ctx.exception)
        self.assertIn("未知内置入口", message)
        self.assertIn("@global_components.script_runner", message)

    def test_none_and_empty_entry_point(self):
        # Must degrade to a plain empty argv element, never [py, None] which
        # would crash Popen with a TypeError.
        self.assertEqual(runner.resolve_argv(self.PY, None), [self.PY, ""])
        self.assertEqual(runner.resolve_argv(self.PY, ""), [self.PY, ""])
        self.assertEqual(runner.resolve_argv(self.PY, "   "), [self.PY, ""])


class _Sandbox(unittest.TestCase):
    """Isolate env vars / sys.path / sys.modules / temp files per test."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sr_core_")
        self.biz_root = os.path.join(self.tmp, "biz")
        os.makedirs(self.biz_root)
        self._saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        self._saved_path = sys.path[:]
        self._saved_modules = set(sys.modules)
        self._counter = 0

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        sys.path[:] = self._saved_path
        for name in list(sys.modules):
            if name not in self._saved_modules:
                del sys.modules[name]
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_module(self, source, *, file_name="job_module.py"):
        """Create ``bizpkgN/job_module.py`` in the business root and return
        its import path. Each call uses a fresh package so cached modules from
        earlier tests can never leak across cases."""
        self._counter += 1
        pkg = f"bizpkg{self._counter}"
        pkg_dir = os.path.join(self.biz_root, pkg)
        os.makedirs(pkg_dir, exist_ok=True)
        open(os.path.join(pkg_dir, "__init__.py"), "w").close()
        with open(os.path.join(pkg_dir, file_name), "w") as f:
            f.write(source)
        return f"{pkg}.{file_name[:-3]}"

    def _wire_env(
        self,
        payload=None,
        *,
        raw_input=None,
        input_path=None,
        output_path=None,
        with_input_env=True,
        with_output_env=True,
        data_dirs=None,
    ):
        if input_path is None:
            input_path = os.path.join(self.tmp, "input.json")
            if raw_input is not None:
                with open(input_path, "w") as f:
                    f.write(raw_input)
            else:
                with open(input_path, "w") as f:
                    json.dump(payload if payload is not None else {}, f)
        if output_path is None:
            output_path = os.path.join(self.tmp, "out", "output.json")

        if with_input_env:
            os.environ["AGENT_UI_INPUT_PATH"] = input_path
        else:
            os.environ.pop("AGENT_UI_INPUT_PATH", None)
        if with_output_env:
            os.environ["AGENT_UI_OUTPUT_PATH"] = output_path
        else:
            os.environ.pop("AGENT_UI_OUTPUT_PATH", None)
        os.environ["AGENT_UI_COMPONENT_ROOT"] = self.biz_root
        if data_dirs is not None:
            os.environ["AGENT_UI_OUTPUT_DATA_DIRS"] = json.dumps(data_dirs)
        else:
            os.environ.pop("AGENT_UI_OUTPUT_DATA_DIRS", None)
        return input_path, output_path

    @staticmethod
    def _run_main():
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            rc = sr_core.main()
        return rc, buf.getvalue()

    @staticmethod
    def _read_output(output_path):
        if not os.path.exists(output_path):
            return None
        with open(output_path, encoding="utf-8") as f:
            return json.load(f)


class ScriptRunnerCoreTests(_Sandbox):
    def test_success_subclass_default_class_name(self):
        module = self._write_module(SUBCLASS_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "message": "hello", "items": [1, 2, 3]}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        out = self._read_output(out_path)
        self.assertEqual(out["echo"], "hello")
        self.assertEqual(out["count"], 3)
        self.assertEqual(out["ratio"], 3.14)
        self.assertIs(out["enabled"], True)
        self.assertEqual(out["path"], "/generic/output/data.parquet")
        self.assertIsInstance(out["path"], str)
        self.assertEqual(out["nested"]["vals"], [1, "two", 3.0])
        self.assertEqual(out["nested"]["deep"], {"ok": True})

    def test_success_duck_typed_custom_class(self):
        module = self._write_module(DUCK_TYPED_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "CustomTask", "value": 42}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), {"got": 42})

    def test_module_and_class_names_are_trimmed(self):
        module = self._write_module(DUCK_TYPED_JOB, file_name="daily_job.py")
        _, out_path = self._wire_env(
            {
                "script.module": f"  {module}  ",
                "script.class": "  CustomTask\n",
                "value": "ok",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), {"got": "ok"})

    def test_none_result_writes_empty_object(self):
        module = self._write_module(NONE_RESULT_JOB)
        _, out_path = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), {})

    def test_routing_keys_stripped_other_inputs_flattened(self):
        module = self._write_module(RECORDS_INPUTS_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "Job",
                "upstream_port": "/data/input.csv",
                "date": "2026-01-01",
                "flags": {"dry_run": False},
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        keys = self._read_output(out_path)["keys"]
        self.assertNotIn("script.module", keys)
        self.assertNotIn("script.class", keys)
        self.assertEqual(
            sorted(keys), sorted(["upstream_port", "date", "flags"])
        )

    def test_missing_module_param(self):
        _, _ = self._wire_env({"script.class": "Job"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_blank_module_param(self):
        _, _ = self._wire_env({"script.module": "   "})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_non_string_module_param(self):
        _, _ = self._wire_env({"script.module": 123})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_non_string_class_param(self):
        module = self._write_module(DUCK_TYPED_JOB)
        _, _ = self._wire_env({"script.module": module, "script.class": 7})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    def test_blank_class_param(self):
        module = self._write_module(DUCK_TYPED_JOB)
        _, _ = self._wire_env({"script.module": module, "script.class": " "})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    def test_module_not_found(self):
        _, _ = self._wire_env({"script.module": "no_such_pkg_xyz.missing"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("导入业务模块失败", err)
        self.assertIn("no_such_pkg_xyz.missing", err)

    def test_import_time_exception_is_wrapped(self):
        module = self._write_module(IMPORT_TIME_FAILURE)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("导入业务模块失败", err)
        self.assertIn("import time boom", err)

    def test_missing_class_lists_defined_classes(self):
        module = self._write_module(OTHER_CLASS_ONLY)
        _, _ = self._wire_env({"script.module": module, "script.class": "Job"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("找不到类", err)
        self.assertIn("Other", err)

    def test_module_without_classes_reports_empty_hint(self):
        module = self._write_module("value = 1\n")
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("模块内没有定义任何类", err)

    def test_target_is_not_a_class(self):
        module = self._write_module(NOT_A_CLASS_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("不是类", err)

    def test_constructor_signature_wrong(self):
        module = self._write_module(BAD_CONSTRUCTOR_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("(inputs, ctx)", err)

    def test_constructor_other_exception_is_wrapped(self):
        module = self._write_module(RAISING_CONSTRUCTOR_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("构造失败", err)
        self.assertIn("constructor boom", err)

    def test_missing_run_method(self):
        module = self._write_module(NO_RUN_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("run()", err)

    def test_business_exception_keeps_full_traceback(self):
        module = self._write_module(BUSINESS_EXCEPTION_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        # Business failures must surface as execution errors WITH a traceback,
        # not be flattened into a one-line config error.
        self.assertIn("任务执行异常", err)
        self.assertIn("Traceback (most recent call last)", err)
        self.assertIn("RuntimeError", err)
        self.assertIn("business boom", err)
        self.assertNotIn("配置/协议错误", err)

    def test_non_dict_result(self):
        module = self._write_module(NON_DICT_RESULT_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("必须返回 dict", err)

    def test_non_string_output_key(self):
        module = self._write_module(NON_STRING_KEY_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("键必须是非空字符串", err)

    def test_empty_output_key(self):
        module = self._write_module(EMPTY_KEY_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("键必须是非空字符串", err)

    def test_nan_rejected(self):
        module = self._write_module(NAN_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("NaN/Infinity", err)

    def test_infinity_rejected(self):
        module = self._write_module(INF_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("NaN/Infinity", err)

    def test_unserializable_type_rejected_with_path(self):
        module = self._write_module(UNSERIALIZABLE_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("$.x", err)
        self.assertIn("set", err)

    def test_input_not_valid_json(self):
        self._wire_env(raw_input="{not json")
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("不是合法 JSON", err)

    def test_input_top_level_not_object(self):
        self._wire_env(raw_input="[1, 2, 3]")
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("顶层必须是对象", err)

    def test_missing_input_env(self):
        self._wire_env(with_input_env=False)
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("AGENT_UI_INPUT_PATH", err)

    def test_unreadable_input_file(self):
        # Pointing the input path at a directory raises OSError on open.
        input_dir = os.path.join(self.tmp, "a_directory")
        os.makedirs(input_dir)
        self._wire_env(input_path=input_dir)
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("读取输入文件失败", err)

    def test_missing_output_env(self):
        module = self._write_module(NONE_RESULT_JOB)
        self._wire_env({"script.module": module}, with_output_env=False)
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("AGENT_UI_OUTPUT_PATH", err)

    def test_output_written_atomically_with_no_tmp_left(self):
        module = self._write_module(SUBCLASS_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "message": "x", "items": []}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        parent = os.path.dirname(out_path)
        self.assertEqual(os.listdir(parent), [os.path.basename(out_path)])
        with open(out_path, encoding="utf-8") as f:
            self.assertIsInstance(json.load(f), dict)

    def test_component_root_added_to_sys_path(self):
        module = self._write_module(SUBCLASS_JOB, file_name="daily_job.py")
        pkg = module.split(".")[0]
        self._wire_env(
            {
                "script.module": f"{pkg}.daily_job",
                "message": "x",
                "items": [],
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertIn(self.biz_root, sys.path)


class RunContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sr_ctx_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._saved = os.environ.get("AGENT_UI_OUTPUT_DATA_DIRS")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("AGENT_UI_OUTPUT_DATA_DIRS", None)
        else:
            os.environ["AGENT_UI_OUTPUT_DATA_DIRS"] = self._saved

    def test_platform_allocated_dir_wins_and_is_created(self):
        allocated = os.path.join(self.tmp, "platform_dirs", "report")
        os.environ["AGENT_UI_OUTPUT_DATA_DIRS"] = json.dumps(
            {"report": allocated}
        )
        ctx = RunContext()
        got = ctx.output_dir("report")
        self.assertEqual(got, allocated)
        self.assertTrue(os.path.isdir(allocated))

    def test_fallback_dir_for_standalone_run(self):
        os.environ.pop("AGENT_UI_OUTPUT_DATA_DIRS", None)
        fallback_root = os.path.join(self.tmp, "fallback")
        ctx = RunContext(fallback_root=fallback_root)
        got = ctx.output_dir("report")
        self.assertEqual(got, os.path.join(fallback_root, "report"))
        self.assertTrue(os.path.isdir(got))

    def test_unknown_port_uses_fallback(self):
        allocated = os.path.join(self.tmp, "platform_dirs", "report")
        os.environ["AGENT_UI_OUTPUT_DATA_DIRS"] = json.dumps(
            {"report": allocated}
        )
        fallback_root = os.path.join(self.tmp, "fallback")
        ctx = RunContext(fallback_root=fallback_root)
        got = ctx.output_dir("other_port")
        self.assertEqual(got, os.path.join(fallback_root, "other_port"))
        self.assertTrue(os.path.isdir(got))

    def test_invalid_port_raises(self):
        ctx = RunContext()
        for bad in ("", None, 123):
            with self.assertRaises(ValueError):
                ctx.output_dir(bad)

    def test_env_is_a_snapshot(self):
        os.environ["SR_TEST_MARKER"] = "present"
        try:
            ctx = RunContext()
        finally:
            os.environ.pop("SR_TEST_MARKER", None)
        self.assertEqual(ctx.env.get("SR_TEST_MARKER"), "present")
        self.assertNotIn("SR_TEST_MARKER", os.environ)

    def test_log_levels_go_to_stderr(self):
        ctx = RunContext()
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            ctx.log.debug("d")
            ctx.log.info("i")
            ctx.log.warning("w")
            ctx.log.error("e")
        lines = buf.getvalue().splitlines()
        self.assertEqual(
            lines,
            [
                "[script-runner] debug: d",
                "[script-runner] info: i",
                "[script-runner] warning: w",
                "[script-runner] error: e",
            ],
        )


class ScriptJobBaseTests(unittest.TestCase):
    class _StubCtx:
        def __init__(self):
            self.log = "LOGGER"
            self.asked = None

        def output_dir(self, port):
            self.asked = port
            return f"/fallback/{port}"

    def test_stores_inputs_and_ctx(self):
        inputs = {"a": 1}
        ctx = self._StubCtx()
        job = ScriptJob(inputs, ctx)
        self.assertIs(job.inputs, inputs)
        self.assertIs(job.ctx, ctx)

    def test_forwards_output_dir_and_log(self):
        ctx = self._StubCtx()
        job = ScriptJob({}, ctx)
        self.assertEqual(job.output_dir("report"), "/fallback/report")
        self.assertEqual(ctx.asked, "report")
        self.assertIs(job.log, "LOGGER")

    def test_run_is_abstract(self):
        job = ScriptJob({}, self._StubCtx())
        with self.assertRaises(NotImplementedError):
            job.run()


class ScriptRunnerEndToEndTests(unittest.TestCase):
    """Full path through runner.run_node with the reserved keyword: the
    business repo contains only a task class, no component boilerplate."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sr_e2e_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_repo(self):
        root = os.path.join(self.tmp, "repo")
        jobs_dir = os.path.join(root, "jobs")
        os.makedirs(jobs_dir)
        open(os.path.join(root, "requirements.txt"), "w").close()
        open(os.path.join(jobs_dir, "__init__.py"), "w").close()
        with open(os.path.join(jobs_dir, "daily_job.py"), "w") as f:
            f.write(E2E_JOB)
        return root

    def test_run_node_executes_business_class_via_keyword(self):
        root = self._make_repo()
        work_dir = os.path.join(self.tmp, "work")
        result = runner.run_node(
            root,
            "@global_components.script_runner",
            {"script.module": "jobs.daily_job", "date": "2026-01-01"},
            work_dir,
            python_path=sys.executable,
            output_ports=["report"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))

        out = result["output_value"]
        self.assertEqual(out["echo"], "2026-01-01")
        report_path = out["report"]["path"]
        # The component wrote into the runner-allocated port directory
        # (work_dir/outputs/report), obtained through ctx.output_dir.
        self.assertEqual(
            os.path.dirname(report_path),
            os.path.join(work_dir, "outputs", "report"),
        )
        self.assertTrue(os.path.isfile(report_path))
        with open(report_path, newline="") as f:
            content = f.read()
        self.assertIn("2026-01-01,1", content)

    def test_run_node_unknown_keyword_fails(self):
        root = self._make_repo()
        with self.assertRaises(ValueError) as ctx:
            runner.run_node(
                root,
                "@no.such.builtin",
                {"script.module": "jobs.daily_job"},
                os.path.join(self.tmp, "work2"),
                python_path=sys.executable,
            )
        self.assertIn("未知内置入口", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
