"""Tests for worker parallel execution (docs/parallel-execution.md §2).

Verifies:
  1. compute_layers groups topologically-independent nodes into one layer.
  2. process runs same-layer nodes CONCURRENTLY (overlapping intervals) and
     passes upstream outputs downstream (data flows across layers).
  3. process honors the global component semaphore (live component "runs"
     never exceed the cap) — the real throttle.
  4. claim_next(exclude_dag_ids=...) enforces per-DAG mutual exclusion so two
     runs of the same DAG never interleave.

Run with:
    python3 test_worker_parallel.py -v
"""

import os
import sys
import json
import time
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import config  # noqa: E402
import db  # noqa: E402
import worker  # noqa: E402

# Isolated DB + cache for the test run (config reads env at call time).
_TMP = tempfile.mkdtemp(prefix="worker-parallel-")
os.environ["AGENT_UI_DB_PATH"] = os.path.join(_TMP, "agent-ui.db")
os.environ["ENGINE_EXECUTOR_CACHE_ROOT"] = os.path.join(_TMP, "cache")
os.environ["ENGINE_EXECUTOR_WORKER_ID"] = "test-worker"
os.environ["ENGINE_EXECUTOR_POLL_INTERVAL"] = "0.05"
os.environ["ENGINE_EXECUTOR_CANCEL_POLL"] = "0.02"


def _create_dag_executions():
    conn = db.connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS dag_executions (
                id TEXT PRIMARY KEY,
                dag_id TEXT NOT NULL,
                status TEXT NOT NULL,
                snapshot TEXT,
                started_at_ms INTEGER,
                completed_at_ms INTEGER,
                outputs TEXT
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS execution_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                node_id TEXT,
                level TEXT NOT NULL,
                message TEXT,
                timestamp_ms INTEGER
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def _reset():
    conn = db.connect()
    try:
        conn.execute("DELETE FROM dag_executions")
        conn.execute("DELETE FROM node_executions")
        conn.commit()
    finally:
        conn.close()


class ComputeLayersTest(unittest.TestCase):
    def test_independent_nodes_same_layer(self):
        plan = {
            "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            "edges": [{"source_node_id": "a", "target_node_id": "c"}],
        }
        layers = worker.Worker.compute_layers(plan)
        self.assertEqual(layers[0], ["a", "b"])  # a and b independent
        self.assertEqual(layers[1], ["c"])        # c depends on a

    def test_diamond(self):
        plan = {
            "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            "edges": [
                {"source_node_id": "a", "target_node_id": "b"},
                {"source_node_id": "a", "target_node_id": "c"},
                {"source_node_id": "b", "target_node_id": "d"},
                {"source_node_id": "c", "target_node_id": "d"},
            ],
        }
        layers = worker.Worker.compute_layers(plan)
        self.assertEqual(layers[0], ["a"])
        self.assertEqual(sorted(layers[1]), ["b", "c"])
        self.assertEqual(layers[2], ["d"])

    def test_cycle_lands_in_final_layer(self):
        plan = {
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [
                {"source_node_id": "a", "target_node_id": "b"},
                {"source_node_id": "b", "target_node_id": "a"},
            ],
        }
        layers = worker.Worker.compute_layers(plan)
        # Both start with indeg 0, so both in layer 0 (cycle handled, not dropped).
        self.assertEqual(set(layers[0]), {"a", "b"})


class ProcessParallelTest(unittest.TestCase):
    def setUp(self):
        _create_dag_executions()
        db.ensure_executor_schema()
        _reset()
        self._orig_resolve = worker.Worker.resolve_node
        worker.Worker.resolve_node = lambda self, node, plan, log_fn=None: (
            "/fake/root", "run.py", ""
        )
        self._orig_run = worker.run_node
        self._intervals = {}
        self._inputs = {}
        self._live = 0
        self._live_max = 0
        self._live_lock = threading.Lock()

        def fake_run(component_root, entry_point, inp, work_dir, **kwargs):
            node_id = os.path.basename(work_dir)
            start = time.time()
            with self._live_lock:
                self._live += 1
                self._live_max = max(self._live_max, self._live)
            time.sleep(0.12)  # overlap window
            with self._live_lock:
                self._live -= 1
            end = time.time()
            self._intervals[node_id] = (start, end)
            self._inputs[node_id] = inp
            return {
                "success": True,
                "cancelled": False,
                "stderr": "",
                "output_value": {"node": node_id},
                "output_path": None,
            }

        worker.run_node = fake_run

    def tearDown(self):
        worker.Worker.resolve_node = self._orig_resolve
        worker.run_node = self._orig_run

    def _insert_exec(self, exec_id, dag_id, plan):
        conn = db.connect()
        try:
            conn.execute(
                "INSERT INTO dag_executions (id, dag_id, status, snapshot, started_at_ms) "
                "VALUES (?, ?, 'submit', ?, ?)",
                (exec_id, dag_id, json.dumps(plan), int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    def test_concurrent_layer_and_data_flow(self):
        # a, b independent (layer 0); c depends on both (layer 1)
        plan = {
            "nodes": [
                {"id": "a", "component_id": "x"},
                {"id": "b", "component_id": "x"},
                {"id": "c", "component_id": "x"},
            ],
            "edges": [
                {"source_node_id": "a", "target_node_id": "c",
                 "source_handle": "out", "target_handle": "portA"},
                {"source_node_id": "b", "target_node_id": "c",
                 "source_handle": "out", "target_handle": "portB"},
            ],
        }
        self._insert_exec("exec1", "dag1", plan)
        w = worker.Worker()
        w.component_sem = threading.Semaphore(2)  # allow both layer-0 nodes at once
        w.process("exec1")

        row = db.get_execution("exec1")
        self.assertEqual(row["status"], "success")

        conn = db.connect()
        statuses = {r["node_id"]: r["status"] for r in conn.execute(
            "SELECT node_id, status FROM node_executions WHERE execution_id='exec1'")}
        conn.close()
        self.assertEqual(statuses, {"a": "success", "b": "success", "c": "success"})

        # a and b (same layer) must have overlapped => ran concurrently.
        a_s, a_e = self._intervals["a"]
        b_s, b_e = self._intervals["b"]
        self.assertTrue(a_s < b_e and b_s < a_e, "layer-0 nodes did not overlap")

        # downstream c received BOTH upstream outputs (proves cross-layer data flow).
        c_inp = self._inputs["c"]
        self.assertEqual(c_inp.get("portA"), {"node": "a"})
        self.assertEqual(c_inp.get("portB"), {"node": "b"})

    def test_semaphore_throttle(self):
        plan = {
            "nodes": [
                {"id": "a", "component_id": "x"},
                {"id": "b", "component_id": "x"},
            ],
            "edges": [],
        }
        self._insert_exec("exec2", "dag2", plan)
        w = worker.Worker()
        w.component_sem = threading.Semaphore(1)  # cap concurrent component runs at 1
        w.process("exec2")

        row = db.get_execution("exec2")
        self.assertEqual(row["status"], "success")
        # With cap=1 and 2 independent nodes, they must NOT run simultaneously.
        self.assertEqual(self._live_max, 1)


class ClaimExclusionTest(unittest.TestCase):
    def setUp(self):
        _create_dag_executions()
        db.ensure_executor_schema()
        _reset()

    def _insert(self, exec_id, dag_id, started):
        conn = db.connect()
        try:
            conn.execute(
                "INSERT INTO dag_executions (id, dag_id, status, started_at_ms) "
                "VALUES (?, ?, 'submit', ?)",
                (exec_id, dag_id, started),
            )
            conn.commit()
        finally:
            conn.close()

    def test_exclude_dag_ids_skips_running_dag(self):
        self._insert("e1", "dagX", 1)
        self._insert("e2", "dagY", 2)
        # dagX is in-flight => excluded => only dagY claimable
        first = db.claim_next(exclude_dag_ids={"dagX"})
        self.assertEqual(first, "e2")
        # e2 now accepted; nothing else claimable under the same exclusion
        second = db.claim_next(exclude_dag_ids={"dagX"})
        self.assertIsNone(second)

    def test_no_exclude_claims_earliest(self):
        self._insert("e1", "dagX", 1)
        self._insert("e2", "dagY", 2)
        self.assertEqual(db.claim_next(), "e1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
