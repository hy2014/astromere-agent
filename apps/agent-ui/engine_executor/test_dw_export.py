"""Tests for the DW (data warehouse) export plumbing — worker resolution/
validation and runner env injection (see docs/dw-export-design.md).

Covers:
  1. worker.resolve_dw_export: disabled → None; valid config →
     {port, table, table_dir}; missing dw_root / port / schema and a bad
     table name all fail loudly.
  2. worker.build_input: instance params are injected for every node (source
     or downstream); `dw.*` / `system.*` UI knobs never leak into the input
     payload, and an upstream port value wins over a colliding param.
  3. runner.run_node output-dir injection: EVERY port gets a directory via
     AGENT_UI_OUTPUT_DATA_DIRS — the DW table dir for the registered port, a
     runner-managed dir for the rest. Components stay DW-ignorant.

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

    def _downstream_input(self, params, src_handle="out:idx", tgt_handle="in:t",
                          upstream_value=None):
        upstream = {"id": "u1", "component_id": "u0", "config": {"params": {}}}
        node = _node_with_params(params)
        node["id"] = "n1"
        edge = {
            "target_node_id": "n1",
            "source_node_id": "u1",
            "source_handle": src_handle,
            "target_handle": tgt_handle,
        }
        plan = {"nodes": [upstream, node], "edges": [edge]}
        return self.w.build_input(
            node, plan, {upstream["id"]: upstream_value or {"idx": ["/f.csv"]}}
        )

    def test_downstream_node_receives_params_plus_port(self):
        inp = self._downstream_input(
            {
                "connection": "Pg-trade",
                "database": "postgres",
                "system.python_path": "/usr/bin/python3",
            }
        )
        self.assertEqual(
            inp, {"connection": "Pg-trade", "database": "postgres", "t": ["/f.csv"]}
        )

    def test_downstream_node_skips_ui_knobs(self):
        inp = self._downstream_input(
            {
                "sql": "SELECT 1",
                "dw.enabled": True,
                "dw.port": "out",
                "dw.table": "t",
            }
        )
        self.assertEqual(inp, {"sql": "SELECT 1", "t": ["/f.csv"]})

    def test_port_wins_on_param_collision(self):
        inp = self._downstream_input({"t": "PARAM"})
        self.assertEqual(inp, {"t": ["/f.csv"]})


class RunNodeOutputDirTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dw_test_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _make_component(self, body):
        root = os.path.join(self.tmp, f"component_{id(body):x}")
        os.makedirs(root)
        # Empty requirements.txt → _ensure_requirements is a no-op.
        open(os.path.join(root, "requirements.txt"), "w").close()
        with open(os.path.join(root, "main.py"), "w") as f:
            f.write(body)
        return root

    def test_invalid_table_rejected_up_front(self):
        root = self._make_component("import os\n")
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
        body = (
            "import json, os\n"
            "data_dirs = json.loads(os.environ['AGENT_UI_OUTPUT_DATA_DIRS'])\n"
            "table_dir = data_dirs['out_port']\n"
            "out_file = os.path.join(table_dir, 'data.txt')\n"
            "with open(out_file, 'w') as f:\n"
            "    f.write('dw-data')\n"
            "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
            "    json.dump({'out_port': out_file}, f)\n"
        )
        root = self._make_component(body)
        dw_root = os.path.join(self.tmp, "dw")
        table_dir = os.path.join(dw_root, "my_table")
        work_dir = os.path.join(self.tmp, "work_ok")
        result = runner.run_node(
            root, "main.py", {}, work_dir,
            python_path=sys.executable,
            dw_export={"port": "out_port", "table": "my_table", "table_dir": table_dir},
            output_ports=["out_port"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        # Table dir created by the runner; component data landed inside it.
        self.assertTrue(os.path.isdir(table_dir))
        data_file = os.path.join(table_dir, "data.txt")
        self.assertTrue(os.path.isfile(data_file))
        # output.json registers the DW path (path-as-contract).
        self.assertEqual(result["output_value"]["out_port"], data_file)

    def test_mixed_ports_dw_and_plain(self):
        # Registered port → DW table dir; the other ports → runner dirs under
        # work_dir/outputs/. The component itself never mentions DW.
        body = (
            "import json, os\n"
            "data_dirs = json.loads(os.environ['AGENT_UI_OUTPUT_DATA_DIRS'])\n"
            "paths = {p: os.path.join(d, 'out.txt') for p, d in data_dirs.items()}\n"
            "for p, f in paths.items():\n"
            "    open(f, 'w').close()\n"
            "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
            "    json.dump(paths, f)\n"
        )
        root = self._make_component(body)
        table_dir = os.path.join(self.tmp, "dw", "my_table")
        work_dir = os.path.join(self.tmp, "work_mixed")
        result = runner.run_node(
            root, "main.py", {}, work_dir,
            python_path=sys.executable,
            dw_export={"port": "dw_port", "table": "my_table", "table_dir": table_dir},
            output_ports=["dw_port", "plain_a", "plain_b"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        self.assertEqual(
            result["output_value"]["dw_port"], os.path.join(table_dir, "out.txt")
        )
        self.assertTrue(os.path.isfile(os.path.join(table_dir, "out.txt")))
        for port in ["plain_a", "plain_b"]:
            expected = os.path.join(work_dir, "outputs", port, "out.txt")
            self.assertEqual(result["output_value"][port], expected)
            self.assertTrue(os.path.isfile(expected))

    def test_no_export_no_ports_keeps_legacy_behavior(self):
        # No dw_export and no output_ports (legacy callers / components that
        # pick their own dirs) → no AGENT_UI_OUTPUT_DATA_DIRS injected.
        body = (
            "import json, os\n"
            "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
            "    json.dump({'has_env': 'AGENT_UI_OUTPUT_DATA_DIRS' in os.environ}, f)\n"
        )
        root = self._make_component(body)
        work_dir = os.path.join(self.tmp, "work_plain")
        result = runner.run_node(root, "main.py", {}, work_dir, python_path=sys.executable)
        self.assertTrue(result["success"], msg=result.get("stderr"))
        self.assertEqual(result["output_value"], {"has_env": False})

    def test_plain_ports_without_dw_get_runner_dirs(self):
        # Instance config without any DW registration: every port still gets a
        # deterministic runner-managed dir (components read the map the same way).
        body = (
            "import json, os\n"
            "data_dirs = json.loads(os.environ['AGENT_UI_OUTPUT_DATA_DIRS'])\n"
            "out_file = os.path.join(data_dirs['out_port'], 'data.txt')\n"
            "open(out_file, 'w').close()\n"
            "with open(os.environ['AGENT_UI_OUTPUT_PATH'], 'w') as f:\n"
            "    json.dump({'out_port': out_file}, f)\n"
        )
        root = self._make_component(body)
        work_dir = os.path.join(self.tmp, "work_nodw")
        result = runner.run_node(
            root, "main.py", {}, work_dir,
            python_path=sys.executable,
            output_ports=["out_port"],
        )
        self.assertTrue(result["success"], msg=result.get("stderr"))
        expected = os.path.join(work_dir, "outputs", "out_port", "data.txt")
        self.assertEqual(result["output_value"]["out_port"], expected)
        self.assertTrue(os.path.isfile(expected))


if __name__ == "__main__":
    unittest.main()
