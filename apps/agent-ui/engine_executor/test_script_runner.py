"""Tests for the built-in generic component ``global_components.script_runner``
and for ``runner.resolve_argv``.

Covers:
  1. resolve_argv: repo-local file passthrough (trimmed), the reserved ``@``
     keyword -> ``python -m ...`` argv (whitespace tolerant), unknown keyword
     fails loudly listing available entries, None / empty input.
  2. `_parse_args`: argv-style node args (`--k v`, `--k=v`, `--flag`, quoted
     values, repeats, multiline) -> named dict; positional tokens / short
     options / empty keys / unclosed quotes rejected; dict passthrough.
  3. core.main status-only protocol, in-process: success with a ScriptJob
     subclass and the default class name, duck-typed class with a custom name,
     whitespace trimming, no params, run() return values deliberately ignored,
     args expanded into params while routing/container/other top-level keys
     never reach the job, every protocol violation (missing/blank/wrong-typed
     routing params, bad args, import failure, missing class with a hint,
     non-class target, bad constructor, missing run(), business exception
     keeping its traceback), malformed input (bad JSON / top-level non-object
     / missing env / unreadable file), the fixed exec_status payload (ok /
     error), missing output env not affecting the exit code, and atomic
     writes.
  4. RunContext: env snapshot, stderr logging.
  5. ScriptJob base: params/ctx storage, log forwarding, abstract run.
  6. End-to-end through runner.run_node: a business repo containing only a
     task class runs via the ``@global_components.script_runner`` keyword;
     the task manages its own file paths; success and failure paths.

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
    "SR_PROBE",
)

# --- Generic business-module sources (no project-specific information) ---
# Jobs cannot return data anymore (status-only component), so test jobs expose
# what they received by dumping params to the probe file named by $SR_PROBE.

PROBE_TEMPLATE = """
import json
import os

{base_import}

class {class_name}({base_class}):
    def run(self):
        probe = os.environ.get("SR_PROBE")
        if probe:
            with open(probe, "w", encoding="utf-8") as f:
                json.dump(dict(sorted(self.params.items())), f)
        {extra_body}
"""

SUBCLASS_PROBE_JOB = PROBE_TEMPLATE.format(
    base_import="from global_components.script_runner import ScriptJob",
    class_name="Job",
    base_class="ScriptJob",
    extra_body="self.log.info('probe ok')",
)

DUCK_PROBE_JOB = """
import json
import os


class CustomTask:
    def __init__(self, params, ctx):
        self.params = params
        self.ctx = ctx

    def run(self):
        probe = os.environ.get("SR_PROBE")
        if probe:
            with open(probe, "w", encoding="utf-8") as f:
                json.dump(dict(sorted(self.params.items())), f)
"""

OK_JOB = """
class Job:
    def __init__(self, params, ctx):
        pass

    def run(self):
        return None
"""

RETURN_VALUE_IGNORED_JOB = """
class Job:
    def __init__(self, params, ctx):
        pass

    def run(self):
        # The component ignores return values: this must still succeed.
        return {"anything": ["unexpected"], "n": 1}
"""

BAD_CONSTRUCTOR_JOB = """
class Job:
    def __init__(self):
        pass

    def run(self):
        pass
"""

RAISING_CONSTRUCTOR_JOB = """
class Job:
    def __init__(self, params, ctx):
        raise ValueError("constructor boom")

    def run(self):
        pass
"""

NO_RUN_JOB = """
class Job:
    def __init__(self, params, ctx):
        pass
"""

BUSINESS_EXCEPTION_JOB = """
class Job:
    def __init__(self, params, ctx):
        pass

    def run(self):
        raise RuntimeError("business boom")
"""

OTHER_CLASS_ONLY = """
class Other:
    def __init__(self, params, ctx):
        pass

    def run(self):
        pass


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
        # The component has no file ports: the task owns its output path,
        # received like any other parameter (including creating directories).
        outfile = self.params["outfile"]
        os.makedirs(os.path.dirname(outfile), exist_ok=True)
        with open(outfile, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "value"])
            writer.writerow([self.params["date"], 1])
        self.log.info("report written")
"""

E2E_FAILING_JOB = """
class Job:
    def __init__(self, params, ctx):
        pass

    def run(self):
        raise RuntimeError("business boom")
"""

OK_STATUS = {"exec_status": {"status": "ok"}}


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


class ParseArgsTests(unittest.TestCase):
    """Rules for the node `args` text (argv-style named parameters)."""

    def test_key_value_pairs(self):
        self.assertEqual(
            sr_core._parse_args("--date 2026-01-01 --mode full"),
            {"date": "2026-01-01", "mode": "full"},
        )

    def test_equals_form(self):
        self.assertEqual(
            sr_core._parse_args("--date=2026-01-01 --mode=full"),
            {"date": "2026-01-01", "mode": "full"},
        )

    def test_mixed_pair_and_equals_forms(self):
        self.assertEqual(
            sr_core._parse_args("--date 2026-01-01 --mode=full"),
            {"date": "2026-01-01", "mode": "full"},
        )

    def test_boolean_flags(self):
        self.assertEqual(
            sr_core._parse_args("--dry-run --verbose"),
            {"dry-run": True, "verbose": True},
        )
        # A flag at the end (nothing follows) must NOT swallow a value later;
        # here it is simply terminal.
        self.assertEqual(sr_core._parse_args("--mode full --force"),
                         {"mode": "full", "force": True})

    def test_flag_followed_by_another_flag(self):
        # The token after a flag also starts with -- => first one is boolean.
        self.assertEqual(
            sr_core._parse_args("--force --mode full"),
            {"force": True, "mode": "full"},
        )

    def test_quoted_value_may_contain_spaces_and_dashes(self):
        self.assertEqual(
            sr_core._parse_args('--msg "hello world" --eq "--literal"'),
            {"msg": "hello world", "eq": "--literal"},
        )

    def test_single_quoted_value(self):
        self.assertEqual(
            sr_core._parse_args("--msg 'hello world'"),
            {"msg": "hello world"},
        )

    def test_dash_dash_value_via_equals_form(self):
        self.assertEqual(
            sr_core._parse_args("--eq=--literal"),
            {"eq": "--literal"},
        )

    def test_empty_value_after_equals(self):
        self.assertEqual(sr_core._parse_args("--note="), {"note": ""})

    def test_values_are_always_strings(self):
        # No smart type coercion: versions / leading-zero ids / dates must
        # survive verbatim; jobs do their own int()/bool().
        parsed = sr_core._parse_args("--limit 100 --ratio 0.5 --zero 007")
        self.assertEqual(parsed, {"limit": "100", "ratio": "0.5", "zero": "007"})
        self.assertIsInstance(parsed["limit"], str)

    def test_repeated_key_last_value_wins(self):
        self.assertEqual(
            sr_core._parse_args("--date a --date b"),
            {"date": "b"},
        )

    def test_none_missing_and_blank_mean_no_args(self):
        self.assertEqual(sr_core._parse_args(None), {})
        self.assertEqual(sr_core._parse_args(""), {})
        self.assertEqual(sr_core._parse_args("   \n\t "), {})

    def test_dict_passes_through(self):
        # Non-UI callers may supply structured args directly.
        self.assertEqual(
            sr_core._parse_args({"date": "2026-01-01", "limit": 100}),
            {"date": "2026-01-01", "limit": 100},
        )

    def test_positional_token_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError) as ctx:
            sr_core._parse_args("positional --date x")
        self.assertIn("无法识别的片段", str(ctx.exception))
        self.assertIn("positional", str(ctx.exception))

    def test_short_option_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError) as ctx:
            sr_core._parse_args("-x 1")
        self.assertIn("无法识别的片段", str(ctx.exception))

    def test_double_dash_alone_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError):
            sr_core._parse_args("--date x --")

    def test_empty_key_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError):
            sr_core._parse_args("--=x")

    def test_unclosed_quote_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError) as ctx:
            sr_core._parse_args('--msg "unclosed')
        self.assertIn("分词", str(ctx.exception))

    def test_non_string_non_dict_rejected(self):
        with self.assertRaises(sr_core.ScriptRunnerError):
            sr_core._parse_args(123)
        with self.assertRaises(sr_core.ScriptRunnerError):
            sr_core._parse_args(["--date", "x"])

    def test_multiline_text(self):
        self.assertEqual(
            sr_core._parse_args("--date 2026-01-01\n  --mode full\n"),
            {"date": "2026-01-01", "mode": "full"},
        )


class _Sandbox(unittest.TestCase):
    """Isolate env vars / sys.path / sys.modules / temp files per test."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sr_core_")
        self.biz_root = os.path.join(self.tmp, "biz")
        os.makedirs(self.biz_root)
        self.probe_path = os.path.join(self.tmp, "probe.json")
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
        os.environ.pop("AGENT_UI_OUTPUT_DATA_DIRS", None)
        # Probe target for jobs that record the params they were constructed with.
        os.environ["SR_PROBE"] = self.probe_path
        return input_path, output_path

    @staticmethod
    def _run_main():
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            rc = sr_core.main()
        return rc, buf.getvalue()

    @staticmethod
    def _read_json(path):
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def _read_output(self, output_path):
        return self._read_json(output_path)

    def _read_probe(self):
        return self._read_json(self.probe_path)


class ScriptRunnerCoreTests(_Sandbox):
    # ---- success paths ----

    def test_success_subclass_default_class_name(self):
        module = self._write_module(SUBCLASS_PROBE_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "args": "--message hello --count 3"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertEqual(
            self._read_probe(), {"message": "hello", "count": "3"}
        )

    def test_success_duck_typed_custom_class(self):
        module = self._write_module(DUCK_PROBE_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "CustomTask",
             "args": "--value 42"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertEqual(self._read_probe(), {"value": "42"})

    def test_module_and_class_names_are_trimmed(self):
        module = self._write_module(DUCK_PROBE_JOB, file_name="daily_job.py")
        _, out_path = self._wire_env(
            {
                "script.module": f"  {module}  ",
                "script.class": "  CustomTask\n",
                "args": "--value ok",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertEqual(self._read_probe(), {"value": "ok"})

    def test_success_without_any_params(self):
        module = self._write_module(OK_JOB)
        _, out_path = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertIsNone(self._read_probe())

    def test_run_return_value_is_ignored(self):
        # Status-only contract: run() must not need to return anything, and a
        # stray non-None value must not be treated as an error either.
        module = self._write_module(RETURN_VALUE_IGNORED_JOB)
        _, out_path = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_args_expanded_into_params(self):
        module = self._write_module(SUBCLASS_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "args": "--date 2026-01-01 --mode=full --dry-run --msg \"hi there\"",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(
            self._read_probe(),
            {"date": "2026-01-01", "mode": "full", "dry-run": True,
             "msg": "hi there"},
        )
        self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_routing_and_container_keys_never_reach_job(self):
        module = self._write_module(SUBCLASS_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "Job",
                "args": "--date 2026-01-01",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_probe(), {"date": "2026-01-01"})

    def test_other_top_level_keys_are_not_inputs(self):
        # Status-only component has no data input ports: stray top-level keys
        # (e.g. leftover edge payloads) must NOT be smuggled into params.
        module = self._write_module(SUBCLASS_PROBE_JOB)
        _, _ = self._wire_env(
            {
                "script.module": module,
                "args": "--date 2026-01-01",
                "upstream_file": "/data/input.csv",
                "nested": {"a": 1},
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_probe(), {"date": "2026-01-01"})

    def test_missing_or_blank_args_means_empty_params(self):
        module = self._write_module(SUBCLASS_PROBE_JOB)
        for args in (None, "", "   \n"):
            self._wire_env({"script.module": module, "args": args})
            rc, err = self._run_main()
            self.assertEqual(rc, 0, msg=err)
            self.assertEqual(self._read_probe(), {})

    def test_bad_args_fails_as_config_error(self):
        module = self._write_module(OK_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "args": "positional-token"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("配置/协议错误", err)
        self.assertIn("无法识别的片段", err)
        status = self._read_output(out_path)["exec_status"]
        self.assertEqual(status["status"], "error")
        self.assertIn("无法识别的片段", status["error"])

    def test_output_written_atomically_with_no_tmp_left(self):
        module = self._write_module(OK_JOB)
        _, out_path = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        parent = os.path.dirname(out_path)
        self.assertEqual(os.listdir(parent), [os.path.basename(out_path)])

    def test_component_root_added_to_sys_path(self):
        module = self._write_module(OK_JOB, file_name="daily_job.py")
        pkg = module.split(".")[0]
        self._wire_env({"script.module": f"{pkg}.daily_job"})
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertIn(self.biz_root, sys.path)

    # ---- config/parameter errors ----

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
        module = self._write_module(DUCK_PROBE_JOB)
        _, _ = self._wire_env({"script.module": module, "script.class": 7})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    def test_blank_class_param(self):
        module = self._write_module(DUCK_PROBE_JOB)
        _, _ = self._wire_env({"script.module": module, "script.class": " "})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    # ---- module/class resolution ----

    def test_module_not_found(self):
        _, out_path = self._wire_env({"script.module": "no_such_pkg_xyz.missing"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("导入业务模块失败", err)
        self.assertIn("no_such_pkg_xyz.missing", err)
        self.assertEqual(
            self._read_output(out_path)["exec_status"]["status"], "error"
        )

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

    # ---- instantiation / execution ----

    def test_constructor_signature_wrong(self):
        module = self._write_module(BAD_CONSTRUCTOR_JOB)
        _, _ = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("(params, ctx)", err)

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

    def test_business_exception_keeps_full_traceback_and_error_status(self):
        module = self._write_module(BUSINESS_EXCEPTION_JOB)
        _, out_path = self._wire_env({"script.module": module})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        # Business failures surface WITH a traceback, not flattened into a
        # one-line config error.
        self.assertIn("任务执行异常", err)
        self.assertIn("Traceback (most recent call last)", err)
        self.assertIn("RuntimeError", err)
        self.assertIn("business boom", err)
        self.assertNotIn("配置/协议错误", err)
        status = self._read_output(out_path)["exec_status"]
        self.assertEqual(status["status"], "error")
        self.assertIn("RuntimeError", status["error"])
        self.assertIn("business boom", status["error"])

    # ---- malformed input ----

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

    def test_missing_output_env_still_succeeds(self):
        # Success is decided by the exit code, not the status file: without
        # AGENT_UI_OUTPUT_PATH the run still succeeds, status write is skipped.
        module = self._write_module(OK_JOB)
        self._wire_env({"script.module": module}, with_output_env=False)
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(err, "")


class RunContextTests(unittest.TestCase):
    def setUp(self):
        self._saved_marker = os.environ.get("SR_TEST_MARKER")

    def tearDown(self):
        if self._saved_marker is None:
            os.environ.pop("SR_TEST_MARKER", None)
        else:
            os.environ["SR_TEST_MARKER"] = self._saved_marker

    def test_env_is_a_snapshot(self):
        os.environ["SR_TEST_MARKER"] = "present"
        ctx = RunContext()
        os.environ["SR_TEST_MARKER"] = "changed-after"
        self.assertEqual(ctx.env.get("SR_TEST_MARKER"), "present")

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

    def test_stores_params_and_ctx(self):
        params = {"a": "1"}
        ctx = self._StubCtx()
        job = ScriptJob(params, ctx)
        self.assertIs(job.params, params)
        self.assertIs(job.ctx, ctx)

    def test_forwards_log(self):
        job = ScriptJob({}, self._StubCtx())
        self.assertIs(job.log, "LOGGER")

    def test_run_is_abstract(self):
        job = ScriptJob({}, self._StubCtx())
        with self.assertRaises(NotImplementedError):
            job.run()


class ScriptRunnerEndToEndTests(unittest.TestCase):
    """Full path through runner.run_node with the reserved keyword: the
    business repo contains only task classes, no component boilerplate."""

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
        with open(os.path.join(jobs_dir, "failing_job.py"), "w") as f:
            f.write(E2E_FAILING_JOB)
        return root

    def test_run_node_success_writes_ok_status(self):
        root = self._make_repo()
        work_dir = os.path.join(self.tmp, "work")
        outfile = os.path.join(self.tmp, "task_own_dir", "report.csv")
        result = runner.run_node(
            root,
            "@global_components.script_runner",
            {
                "script.module": "jobs.daily_job",
                "args": f"--date 2026-01-01 --outfile {outfile}",
            },
            work_dir,
            python_path=sys.executable,
            output_ports=["exec_status"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        self.assertEqual(
            result["output_value"], {"exec_status": {"status": "ok"}}
        )
        # The task managed its own output path; the component provided no
        # file port directories for it.
        self.assertTrue(os.path.isfile(outfile))
        with open(outfile, newline="") as f:
            self.assertIn("2026-01-01,1", f.read())

    def test_run_node_business_exception_fails_node(self):
        root = self._make_repo()
        result = runner.run_node(
            root,
            "@global_components.script_runner",
            {"script.module": "jobs.failing_job"},
            os.path.join(self.tmp, "work_fail"),
            python_path=sys.executable,
            output_ports=["exec_status"],
        )
        self.assertFalse(result["success"])
        self.assertIn("business boom", result.get("stderr", ""))
        self.assertEqual(
            result["output_value"],
            {"exec_status": {"status": "error",
                             "error": "RuntimeError: business boom"}},
        )

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
