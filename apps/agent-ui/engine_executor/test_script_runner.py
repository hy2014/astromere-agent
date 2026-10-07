"""Tests for the built-in generic component ``global_components.script_runner``
and for ``runner.resolve_argv``.

Covers:
  1. resolve_argv: repo-local file passthrough (trimmed), the reserved ``@``
     keyword -> ``python -m ...`` argv (whitespace tolerant), unknown keyword
     fails loudly listing available entries, None / empty input.
  2. `_parse_args`: argv-style node args (`--k v`, `--k=v`, `--flag`, quoted
     values, repeats, multiline) -> named dict; positional tokens / short
     options / empty keys / unclosed quotes rejected; dict passthrough.
  3. core.main status-only protocol, in-process: task classes without a custom
     ``__init__``, ``run(self, params)`` and ``run(self, params, ctx)``
     dispatched by signature inspection, explicit ``script.class`` routing
     (including multiple classes in one module), whitespace trimming, no
     params, run() return values deliberately ignored, args expanded into
     params while routing/container/other top-level keys never reach the task,
     every protocol violation (missing/blank/wrong-typed routing params, bad
     args, import failure, missing class with a hint, non-class target,
     parameterized constructor, constructor raising, missing run(), bad run
     signatures, business exception keeping its traceback), malformed input
     (bad JSON / top-level non-object / missing env / unreadable file), the
     fixed exec_status payload (ok / error), missing output env not affecting
     the exit code, and atomic writes.
  4. RunContext: env snapshot, stderr logging.
  5. End-to-end through runner.run_node: a business repo containing only task
     classes runs via the ``@global_components.script_runner`` keyword; the
     task manages its own file paths; success and failure paths.

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
from global_components.script_runner import RunContext  # noqa: E402
from global_components.script_runner import core as sr_core  # noqa: E402

ENV_KEYS = (
    "AGENT_UI_INPUT_PATH",
    "AGENT_UI_OUTPUT_PATH",
    "AGENT_UI_COMPONENT_ROOT",
    "AGENT_UI_OUTPUT_DATA_DIRS",
    "SR_PROBE",
)

# --- Generic business-module sources (no project-specific information) ---
# Tasks cannot return data anymore (status-only component), so probe tasks
# expose what they received by dumping params to the file named by $SR_PROBE.

PARAMS_PROBE_JOB = """
import json
import os


class ParamsProbeTask:
    def run(self, params):
        probe = os.environ.get("SR_PROBE")
        if probe:
            with open(probe, "w", encoding="utf-8") as f:
                json.dump(dict(sorted(params.items())), f)
"""

CTX_PROBE_JOB = """
import json
import os


class CtxProbeTask:
    def run(self, params, ctx):
        ctx.log.info("ctx marker present")
        probe = os.environ.get("SR_PROBE")
        if probe:
            with open(probe, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "params": dict(sorted(params.items())),
                        "ctx_type": type(ctx).__name__,
                    },
                    f,
                )
"""

TWO_TASKS_ONE_MODULE = """
class FullTask:
    def run(self, params):
        pass


class IncrementalTask:
    def run(self, params, ctx):
        pass
"""

OK_JOB = """
class SimpleTask:
    def run(self, params):
        return None
"""

RETURN_VALUE_IGNORED_JOB = """
class SimpleTask:
    def run(self, params):
        # The component ignores return values: this must still succeed.
        return {"anything": ["unexpected"], "n": 1}
"""

RUN_WITH_DEFAULT_CTX = """
class DefaultCtxTask:
    def run(self, params, optional_ctx=None):
        # Two declared parameters => the platform always passes ctx
        # positionally, so the default never matters but must stay callable.
        if optional_ctx is None or not hasattr(optional_ctx, "log"):
            raise AssertionError("ctx should have been passed")
"""

BAD_CONSTRUCTOR_JOB = """
class TaskWithCtor:
    def __init__(self, required):
        self.required = required

    def run(self, params):
        pass
"""

RAISING_CONSTRUCTOR_JOB = """
class TaskRaisingCtor:
    def __init__(self):
        raise ValueError("constructor boom")

    def run(self, params):
        pass
"""

NO_RUN_JOB = """
class TaskWithoutRun:
    pass
"""

RUN_ZERO_PARAMS = """
class TaskRunNoParams:
    def run(self):
        pass
"""

RUN_THREE_PARAMS = """
class TaskRunThreeParams:
    def run(self, params, ctx, extra):
        pass
"""

RUN_VARARGS = """
class TaskRunVarArgs:
    def run(self, params, *extra):
        pass
"""

RUN_KWARGS = """
class TaskRunKwArgs:
    def run(self, params, **extra):
        pass
"""

BUSINESS_EXCEPTION_JOB = """
class FailingTask:
    def run(self, params):
        raise RuntimeError("business boom")
"""

OTHER_CLASS_ONLY = """
class Other:
    def run(self, params):
        pass


not_a_class = 42
"""

NOT_A_CLASS_JOB = """
SimpleTask = 42
"""

IMPORT_TIME_FAILURE = """
raise RuntimeError("import time boom")
"""

E2E_JOB = """
import csv
import os


class BuildReport:
    def run(self, params):
        # The component has no file ports: the task owns its output path,
        # received like any other parameter (including creating directories).
        outfile = params["outfile"]
        os.makedirs(os.path.dirname(outfile), exist_ok=True)
        with open(outfile, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "value"])
            writer.writerow([params["date"], 1])


class FailingTask:
    def run(self, params):
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
        # survive verbatim; tasks do their own int()/bool().
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
        # Probe target for tasks that record the params they received.
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

    def test_success_run_with_params_only(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "ParamsProbeTask",
                "args": "--message hello --count 3",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertEqual(
            self._read_probe(), {"message": "hello", "count": "3"}
        )

    def test_success_run_with_params_and_ctx(self):
        module = self._write_module(CTX_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "CtxProbeTask",
                "args": "--value 42",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        # ctx was actually injected (not None), and the task could log.
        self.assertEqual(
            self._read_probe(),
            {"params": {"value": "42"}, "ctx_type": "RunContext"},
        )
        self.assertIn("ctx marker present", err)

    def test_explicit_class_selects_between_two_tasks(self):
        module = self._write_module(TWO_TASKS_ONE_MODULE)
        for class_name in ("FullTask", "IncrementalTask"):
            _, out_path = self._wire_env(
                {"script.module": module, "script.class": class_name}
            )
            rc, err = self._run_main()
            self.assertEqual(rc, 0, msg=f"{class_name}: {err}")
            self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_module_and_class_names_are_trimmed(self):
        module = self._write_module(PARAMS_PROBE_JOB, file_name="daily_job.py")
        _, out_path = self._wire_env(
            {
                "script.module": f"  {module}  ",
                "script.class": "  ParamsProbeTask\n",
                "args": "--value ok",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertEqual(self._read_probe(), {"value": "ok"})

    def test_success_without_any_params(self):
        module = self._write_module(OK_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)
        self.assertIsNone(self._read_probe())

    def test_run_return_value_is_ignored(self):
        # Status-only contract: run() must not need to return anything, and a
        # stray non-None value must not be treated as an error either.
        module = self._write_module(RETURN_VALUE_IGNORED_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_run_with_default_second_param_still_gets_ctx(self):
        module = self._write_module(RUN_WITH_DEFAULT_CTX)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "DefaultCtxTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_args_expanded_into_params(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "ParamsProbeTask",
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

    def test_routing_and_container_keys_never_reach_task(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "ParamsProbeTask",
                "args": "--date 2026-01-01",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_probe(), {"date": "2026-01-01"})
        self.assertEqual(self._read_output(out_path), OK_STATUS)

    def test_other_top_level_keys_are_not_inputs(self):
        # Status-only component has no data input ports: stray top-level keys
        # (e.g. leftover edge payloads) must NOT be smuggled into params.
        module = self._write_module(PARAMS_PROBE_JOB)
        _, _ = self._wire_env(
            {
                "script.module": module,
                "script.class": "ParamsProbeTask",
                "args": "--date 2026-01-01",
                "upstream_file": "/data/input.csv",
                "nested": {"a": 1},
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertEqual(self._read_probe(), {"date": "2026-01-01"})

    def test_missing_or_blank_args_means_empty_params(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        for args in (None, "", "   \n"):
            self._wire_env(
                {
                    "script.module": module,
                    "script.class": "ParamsProbeTask",
                    "args": args,
                }
            )
            rc, err = self._run_main()
            self.assertEqual(rc, 0, msg=err)
            self.assertEqual(self._read_probe(), {})

    def test_bad_args_fails_as_config_error(self):
        module = self._write_module(OK_JOB)
        _, out_path = self._wire_env(
            {
                "script.module": module,
                "script.class": "SimpleTask",
                "args": "positional-token",
            }
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
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        parent = os.path.dirname(out_path)
        self.assertEqual(os.listdir(parent), [os.path.basename(out_path)])

    def test_component_root_added_to_sys_path(self):
        module = self._write_module(OK_JOB, file_name="daily_job.py")
        pkg = module.split(".")[0]
        self._wire_env(
            {"script.module": f"{pkg}.daily_job", "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 0, msg=err)
        self.assertIn(self.biz_root, sys.path)

    # ---- config/parameter errors ----

    def test_missing_module_param(self):
        _, _ = self._wire_env({"script.class": "SimpleTask"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_blank_module_param(self):
        _, _ = self._wire_env(
            {"script.module": "   ", "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_non_string_module_param(self):
        _, _ = self._wire_env(
            {"script.module": 123, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.module", err)

    def test_missing_class_param(self):
        # script.class is mandatory: there is no implicit default class name.
        _, _ = self._wire_env({"script.module": "some.module"})
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    def test_blank_class_param(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": " "}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    def test_non_string_class_param(self):
        module = self._write_module(PARAMS_PROBE_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": 7}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("script.class", err)

    # ---- module/class resolution ----

    def test_module_not_found(self):
        _, out_path = self._wire_env(
            {
                "script.module": "no_such_pkg_xyz.missing",
                "script.class": "SimpleTask",
            }
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("导入业务模块失败", err)
        self.assertIn("no_such_pkg_xyz.missing", err)
        self.assertEqual(
            self._read_output(out_path)["exec_status"]["status"], "error"
        )

    def test_import_time_exception_is_wrapped(self):
        module = self._write_module(IMPORT_TIME_FAILURE)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("导入业务模块失败", err)
        self.assertIn("import time boom", err)

    def test_missing_class_lists_defined_classes(self):
        module = self._write_module(OTHER_CLASS_ONLY)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("找不到类", err)
        self.assertIn("Other", err)

    def test_module_without_classes_reports_empty_hint(self):
        module = self._write_module("value = 1\n")
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "Anything"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("模块内没有定义任何类", err)

    def test_target_is_not_a_class(self):
        module = self._write_module(NOT_A_CLASS_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("不是类", err)

    # ---- instantiation / run signature ----

    def test_constructor_with_params_rejected(self):
        module = self._write_module(BAD_CONSTRUCTOR_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskWithCtor"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("无参实例化", err)
        self.assertIn("__init__", err)

    def test_constructor_other_exception_is_wrapped(self):
        module = self._write_module(RAISING_CONSTRUCTOR_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskRaisingCtor"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("实例化失败", err)
        self.assertIn("constructor boom", err)

    def test_missing_run_method(self):
        module = self._write_module(NO_RUN_JOB)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskWithoutRun"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("run()", err)

    def test_run_without_params_rejected(self):
        module = self._write_module(RUN_ZERO_PARAMS)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskRunNoParams"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("run(self, params)", err)

    def test_run_with_three_params_rejected(self):
        module = self._write_module(RUN_THREE_PARAMS)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskRunThreeParams"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("run(self, params)", err)
        self.assertIn("3 个位置形参", err)

    def test_run_with_varargs_rejected(self):
        module = self._write_module(RUN_VARARGS)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskRunVarArgs"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("*args/**kwargs", err)

    def test_run_with_kwargs_rejected(self):
        module = self._write_module(RUN_KWARGS)
        _, _ = self._wire_env(
            {"script.module": module, "script.class": "TaskRunKwArgs"}
        )
        rc, err = self._run_main()
        self.assertEqual(rc, 1)
        self.assertIn("*args/**kwargs", err)

    def test_business_exception_keeps_full_traceback_and_error_status(self):
        module = self._write_module(BUSINESS_EXCEPTION_JOB)
        _, out_path = self._wire_env(
            {"script.module": module, "script.class": "FailingTask"}
        )
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
        self._wire_env(
            {"script.module": module, "script.class": "SimpleTask"},
            with_output_env=False,
        )
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
        # Both task classes live in one module; script.class picks which one
        # the node executes.
        with open(os.path.join(jobs_dir, "daily_job.py"), "w") as f:
            f.write(E2E_JOB)
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
                "script.class": "BuildReport",
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

    def test_run_node_class_routing_to_failing_task(self):
        root = self._make_repo()
        result = runner.run_node(
            root,
            "@global_components.script_runner",
            {
                "script.module": "jobs.daily_job",
                "script.class": "FailingTask",
            },
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
                {
                    "script.module": "jobs.daily_job",
                    "script.class": "BuildReport",
                },
                os.path.join(self.tmp, "work2"),
                python_path=sys.executable,
            )
        self.assertIn("未知内置入口", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
