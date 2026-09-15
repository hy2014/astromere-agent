"""Tests for the DW (data warehouse) export plumbing — worker resolution/
validation and runner env injection (see docs/dw-export-design.md).

Covers:
  1. worker.resolve_dw_export: disabled → None; valid config →
     {port, table, table_dir}; missing dw_root / port / schema and a bad
     table name all fail loudly.
  2. worker.build_input: source nodes never leak `dw.*` / `system.*` UI knobs
     into the input payload.
  3. runner.run_node with dw_export: path-traversal table names are rejected
     up front; a valid export creates the table dir, injects
     AGENT_UI_OUTPUT_DATA_DIRS, and the component's registered output path
     lands under `{dw_root}/{table}/`.

Run with:
    python3 test_dw_export.py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import runner  # noqa: E402
from worker import Worker  # noqa: E402


def _bare_worker() -> Worker:
    """A Worker instance without __init__ (no thread pools needed here)."""
    return Worker.__new__(Worker)


def _node_with_params(params, output_schema=None):
    config = {"params": params}
    if output_schema is not None:
        config["outputSchema"] = output_schema
    return {"id": "n1", "component_id": "c1", "config": config}


def _plan(dw_root="/data/dw"):
    plan = {
        "execution_order": ["n1"],
        "nodes": [],
        "edges": [],
    }
    if dw_root is not None:
        plan["dw_root"] = dw_root
    return plan


class ResolveDwExportTests(unittest.TestCase):
    def setUp(self):
        self.w = _bare_worker()

    def test_disabled_returns_none(self):
        node = _node_with_params({"dw.enabled": False, "dw.port": "out", "dw.table": "t"})
        self.assertIsNone(self.w.resolve_dw_export(node, _plan()))
        self.assertIsNone(self.w.resolve_dw_export(_node_with_params({}), _plan()))

    def test_valid_config(self):
        node = _node_with_params(
            {"dw.enabled": True, "dw.port": "out_features", "dw.table": "demo_table"},
            output_schema={
                "type": "object",
                "properties": {"out_features": {"type": "string", "format": "parquet"}},
            },
        )
        got = self.w.resolve_dw_export(node, _plan())
        self.assertEqual(got["port"], "out_features")
        self.assertEqual(got["table"], "demo_table")
        self.assertEqual(got["table_dir"], os.path.join("/data/dw", "demo_table"))

    def test_missing_dw_root_fails(self):
        node = _node_with_params(
            {"dw.enabled": True, "dw.port": "p", "dw.table": "t"},
            output_schema={"type": "object", "properties": {"p": {}}},
        )
        with self.assertRaises(ValueError):
            self.w.resolve_dw_export(node, _plan(dw_root=""))
        # Legacy snapshots have no dw_root key at all.
        with self.assertRaises(ValueError):
            self.w.resolve_dw_export(node, _plan(dw_root=None))

    def test_missing_port_fails(self):
        node = _node_with_params(
            {"dw.enabled": True, "dw.table": "t"},
            output_schema={"type": "object", "properties": {"p": {}}},
        )
        with self.assertRaises(ValueError):
            self.w.resolve_dw_export(node, _plan())

    def test_bad_table_names_fail(self):
        for bad in ["../escape", "a/b", "/abs", "a b", "..", ""]:
            node = _node_with_params(
                {"dw.enabled": True, "dw.port": "p", "dw.table": bad},
                output_schema={"type": "object", "properties": {"p": {}}},
            )
            with self.assertRaises(ValueError, msg=f"table={bad!r}"):
                self.w.resolve_dw_export(node, _plan())

    def test_unknown_port_fails(self):
        node = _node_with_params(
            {"dw.enabled": True, "dw.port": "nope", "dw.table": "t"},
            output_schema={"type": "object", "properties": {"p": {}}},
        )
        with self.assertRaises(ValueError):
            self.w.resolve_dw_export(node, _plan())

    def test_missing_output_schema_fails(self):
        node = _node_with_params({"dw.enabled": True, "dw.port": "p", "dw.table": "t"})
        with self.assertRaises(ValueError):
            self.w.resolve_dw_export(node, _plan())


class BuildInputFilterTests(unittest.TestCase):
    def setUp(self):
        self.w = _bare_worker()

    def test_source_node_filters_ui_knobs(self):
        node = _node_with_params(
            {
                "symbol": "000001",
                "system.python_path": "/usr/bin/python3",
                "dw.enabled": True,
                "dw.port": "out",
                "dw.table": "t",
            }
        )
        plan = {"nodes": [node], "edges": []}
        inp = self.w.build_input(node, plan, {})
        self.assertEqual(inp, {"symbol": "000001"})


class RunNodeDwExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dw_test_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _make_component(self):
        root = os.path.join(self.tmp, "component")
        os.makedirs(root)
        # Empty requirements.txt → _ensure_requirements is a no-op.
        open(os.path.join(root, "requirements.txt"), "w").close()
        with open(os.path.join(root, "main.py"), "w") as f:
            f.write(
                "import json, os\n"
                "data_dirs = json.loads(os.environ['AGENT_UI_OUTPUT_DATA_DIRS'])\n"
                "table_dir = data_dirs['out_port']\n"
                "out_file = os.path.join(table_dir, 'data.txt')\n"
                "with open(out_file, 'w') as f:\n"
                "    f.write('dw-data')\n"
                "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
                "    json.dump({'out_port': out_file}, f)\n"
            )
        return root

    def test_invalid_table_rejected_up_front(self):
        root = self._make_component()
        work_dir = os.path.join(self.tmp, "work_bad")
        outside = os.path.join(self.tmp, "escape")
        with self.assertRaises(ValueError):
            runner.run_node(
                root, "main.py", {}, work_dir,
                python_path=sys.executable,
                dw_export={"port": "out_port", "table": "../escape", "table_dir": outside},
            )
        self.assertFalse(os.path.exists(outside))

    def test_valid_export_writes_into_table_dir(self):
        root = self._make_component()
        dw_root = os.path.join(self.tmp, "dw")
        table_dir = os.path.join(dw_root, "my_table")
        work_dir = os.path.join(self.tmp, "work_ok")
        result = runner.run_node(
            root, "main.py", {}, work_dir,
            python_path=sys.executable,
            dw_export={"port": "out_port", "table": "my_table", "table_dir": table_dir},
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        # Table dir created by the runner; component data landed inside it.
        self.assertTrue(os.path.isdir(table_dir))
        data_file = os.path.join(table_dir, "data.txt")
        self.assertTrue(os.path.isfile(data_file))
        # output.json registers the DW path (path-as-contract).
        self.assertEqual(result["output_value"]["out_port"], data_file)

    def test_no_dw_export_keeps_legacy_behavior(self):
        root = self._make_component()
        work_dir = os.path.join(self.tmp, "work_plain")
        result = runner.run_node(root, "main.py", {}, work_dir, python_path=sys.executable)
        # Without dw_export the component sees no AGENT_UI_OUTPUT_DATA_DIRS and
        # fails on KeyError → we assert the env var was NOT injected instead by
        # running a probe component.
        probe = os.path.join(self.tmp, "probe")
        os.makedirs(probe)
        open(os.path.join(probe, "requirements.txt"), "w").close()
        with open(os.path.join(probe, "main.py"), "w") as f:
            f.write(
                "import json, os\n"
                "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
                "    json.dump({'has_env': 'AGENT_UI_OUTPUT_DATA_DIRS' in os.environ}, f)\n"
            )
        result = runner.run_node(probe, "main.py", {}, work_dir, python_path=sys.executable)
        self.assertTrue(result["success"], msg=result.get("stderr"))
        self.assertEqual(result["output_value"], {"has_env": False})


if __name__ == "__main__":
    unittest.main()
