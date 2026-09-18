"""Tests for the platform SDK (`component_sdk`) and the runner's injection of
it into component processes.

Covers:
  1. Port-value normalization: raw path / file card / list (mixed) → list[str];
     single value wraps to a one-element list; unusable entries are skipped.
  2. `resolve_output_dir`: unset env → None (standalone runs fall back to their
     own temp dir), malformed JSON → None, unknown port → None.
  3. End-to-end through `runner.run_node`: the component subprocess can
     `import component_sdk` (PYTHONPATH + AGENT_UI_SDK_PATH are injected) and
     reads a list-valued input port as a plain path list.

Run with:
    python3 test_component_sdk.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "sdk"))

import runner  # noqa: E402
from component_sdk import read_input_files, read_input_port, resolve_output_dir  # noqa: E402


class _Env:
    """Temporarily set/clear the AGENT_UI_* env vars the SDK reads."""

    def __init__(self, **values):
        self.values = values
        self.saved = {}

    def __enter__(self):
        for key, value in self.values.items():
            self.saved[key] = os.environ.get(key)
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return self

    def __exit__(self, *exc):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        return False


class NormalizationTests(unittest.TestCase):
    def _with_input(self, port, value):
        tmp = tempfile.mkdtemp(prefix="sdk_test_")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        path = os.path.join(tmp, "input.json")
        with open(path, "w") as f:
            json.dump({port: value}, f)
        return _Env(AGENT_UI_INPUT_PATH=path)

    def test_single_raw_path_wraps_into_list(self):
        with self._with_input("p", "/abs/a.csv"):
            self.assertEqual(read_input_files("p"), ["/abs/a.csv"])

    def test_single_card_wraps_into_list(self):
        card = {"path": "/abs/a.parquet", "format": "parquet"}
        with self._with_input("p", card):
            self.assertEqual(read_input_files("p"), ["/abs/a.parquet"])

    def test_mixed_list_is_flattened(self):
        # Elements may be cards, raw paths, or a mix — and paths may be dirs.
        value = [
            {"path": "/dw/month=202401", "format": "parquet"},
            "/dw/month=202402",
            {"path": "/dw/month=202403", "format": "parquet"},
        ]
        with self._with_input("p", value):
            self.assertEqual(
                read_input_files("p"),
                ["/dw/month=202401", "/dw/month=202402", "/dw/month=202403"],
            )

    def test_one_element_list_equals_single_value(self):
        with self._with_input("p", [{"path": "/abs/a.csv", "format": "csv"}]):
            as_list = read_input_files("p")
        with self._with_input("p", {"path": "/abs/a.csv", "format": "csv"}):
            as_single = read_input_files("p")
        self.assertEqual(as_list, as_single)

    def test_missing_port_and_empty_list(self):
        with self._with_input("p", []):
            self.assertEqual(read_input_files("p"), [])
        with self._with_input("p", []):
            self.assertEqual(read_input_files("other"), [])

    def test_unusable_entries_are_skipped(self):
        value = ["", {"format": "csv"}, 42, None, "/kept.csv"]
        with self._with_input("p", value):
            self.assertEqual(read_input_files("p"), ["/kept.csv"])

    def test_read_input_port_returns_raw_value(self):
        value = {"path": "/abs/a.csv", "format": "csv"}
        with self._with_input("p", value):
            self.assertEqual(read_input_port("p"), value)
            self.assertIsNone(read_input_port("missing"))

    def test_no_input_path_yields_empty(self):
        with _Env(AGENT_UI_INPUT_PATH=None):
            self.assertEqual(read_input_files("p"), [])
            self.assertIsNone(read_input_port("p"))


class ResolveOutputDirTests(unittest.TestCase):
    def test_unset_env_returns_none(self):
        # Standalone runs (no platform) must fall back to their own temp dir.
        with _Env(AGENT_UI_OUTPUT_DATA_DIRS=None):
            self.assertIsNone(resolve_output_dir("out"))

    def test_resolves_only_allocated_ports(self):
        mapping = {"out": "/dw/table", "other": "/work/outputs/other"}
        with _Env(AGENT_UI_OUTPUT_DATA_DIRS=json.dumps(mapping)):
            self.assertEqual(resolve_output_dir("out"), "/dw/table")
            self.assertEqual(resolve_output_dir("other"), "/work/outputs/other")
            self.assertIsNone(resolve_output_dir("not_a_port"))

    def test_malformed_json_returns_none(self):
        for raw in ["not json", "[]", '"str"']:
            with _Env(AGENT_UI_OUTPUT_DATA_DIRS=raw):
                self.assertIsNone(resolve_output_dir("out"), msg=raw)


class RunnerInjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sdk_runner_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _make_component(self):
        root = os.path.join(self.tmp, "component")
        os.makedirs(root)
        open(os.path.join(root, "requirements.txt"), "w").close()
        with open(os.path.join(root, "main.py"), "w") as f:
            f.write(
                "import json, os\n"
                "from component_sdk import read_input_files, resolve_output_dir\n"
                "paths = read_input_files('in_port')\n"
                "out_dir = resolve_output_dir('out_port')\n"
                "out_file = os.path.join(out_dir, 'joined.txt')\n"
                "with open(out_file, 'w') as fh:\n"
                "    fh.write(';'.join(paths))\n"
                "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as fh:\n"
                "    json.dump({'out_port': {'path': out_file, 'format': 'csv'},\n"
                "               'sdk_path': os.environ.get('AGENT_UI_SDK_PATH')}, fh)\n"
            )
        return root

    def test_component_imports_sdk_and_reads_list_port(self):
        root = self._make_component()
        work_dir = os.path.join(self.tmp, "work")
        cards = [
            {"path": "/dw/month=202401", "format": "parquet"},
            "/dw/month=202402",
        ]
        result = runner.run_node(
            root,
            "main.py",
            {"in_port": cards},
            work_dir,
            python_path=sys.executable,
            output_ports=["out_port"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))

        # The platform allocated the output dir and the component wrote into it.
        expected_dir = os.path.join(work_dir, "outputs", "out_port")
        out_file = os.path.join(expected_dir, "joined.txt")
        self.assertEqual(result["output_value"]["out_port"]["path"], out_file)
        with open(out_file) as fh:
            self.assertEqual(fh.read(), "/dw/month=202401;/dw/month=202402")

        # The SDK dir was injected and points at this platform checkout.
        self.assertEqual(result["output_value"]["sdk_path"], runner._sdk_dir())
        self.assertTrue(os.path.isfile(os.path.join(runner._sdk_dir(), "component_sdk", "__init__.py")))

    def test_dw_dir_wins_for_the_registered_port(self):
        root = self._make_component()
        table_dir = os.path.join(self.tmp, "dw", "my_table")
        result = runner.run_node(
            root,
            "main.py",
            {"in_port": "/abs/a.csv"},
            os.path.join(self.tmp, "work_dw"),
            python_path=sys.executable,
            dw_export={"port": "out_port", "table": "my_table", "table_dir": table_dir},
            output_ports=["out_port"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        self.assertEqual(
            result["output_value"]["out_port"]["path"],
            os.path.join(table_dir, "joined.txt"),
        )


if __name__ == "__main__":
    unittest.main()