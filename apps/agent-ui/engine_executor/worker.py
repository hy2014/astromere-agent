#!/usr/bin/env python3
"""engine_executor — Python execution engine (consumer side).

Runs as a standalone process. Polls the shared SQLite DB for ``dag_executions``
rows with status ``submit``, atomically claims them, then drives each node
through the state machine:

    submit --(claim)--> accepted --> [per node: preparing --> running --> success|failed]
                              |
                              +--> cancelled (on cancel_requested)

The whole execution ends in ``success`` / ``failed`` / ``cancelled``. All
transitions and stdout/stderr are persisted so the UI can poll them.

Run:
    python3 worker.py
Environment:
    AGENT_UI_DB_PATH, ENGINE_EXECUTOR_POLL_INTERVAL, ENGINE_EXECUTOR_CACHE_ROOT,
    ENGINE_EXECUTOR_WORKER_ID, ENGINE_EXECUTOR_CANCEL_POLL
"""

import json
import os
import signal
import sys
import time
from collections import deque

import config
from db import (
    add_log,
    claim_next,
    ensure_executor_schema,
    get_component,
    get_dag_plan,
    get_execution,
    is_cancel_requested,
    set_execution_status,
    upsert_node_execution,
)
from runner import prepare_env, run_node


class Worker:
    def __init__(self):
        self.stop = False
        try:
            signal.signal(signal.SIGTERM, self._on_signal)
            signal.signal(signal.SIGINT, self._on_signal)
        except ValueError:
            # Not in main thread; ignore (tests run worker as subprocess, fine).
            pass

    def _on_signal(self, *_a):
        self.stop = True

    @staticmethod
    def compute_order(plan):
        order = plan.get("execution_order")
        if order:
            try:
                arr = json.loads(order) if isinstance(order, str) else order
                ids = [x for x in arr if isinstance(x, str)]
                if ids:
                    return ids
            except Exception:
                pass
        # Fallback: topological sort from nodes/edges.
        nodes = plan["nodes"]
        edges = plan["edges"]
        indeg = {n["id"]: 0 for n in nodes}
        adj = {n["id"]: [] for n in nodes}
        for e in edges:
            adj[e["source_node_id"]].append(e["target_node_id"])
            indeg[e["target_node_id"]] = indeg.get(e["target_node_id"], 0) + 1
        q = deque(nid for nid, d in indeg.items() if d == 0)
        out = []
        while q:
            nid = q.popleft()
            out.append(nid)
            for nxt in adj[nid]:
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    q.append(nxt)
        return out

    @staticmethod
    def parse_config(node):
        cfg = node.get("config")
        if isinstance(cfg, str):
            try:
                return json.loads(cfg) if cfg else {}
            except Exception:
                return {}
        return cfg or {}

    def build_input(self, node, plan, node_outputs):
        """Assemble the ``input.json`` payload for a node.

        Port-level IO mapping (see docs/dag.md "边与 IO 映射"): each edge's
        ``source_handle`` selects which output port to read from the upstream
        node's outputs map, and ``target_handle`` names the key under which that
        value lands in this node's input. This lets a multi-output component feed
        different downstream nodes different artifacts.

        Source nodes (no upstream edges) receive their instance ``params``
        (the ``node.config.params`` map) as the input payload.
        """
        cfg = self.parse_config(node)
        upstream = [e for e in plan["edges"] if e["target_node_id"] == node["id"]]
        if not upstream:
            # Source node: instance params (node.config.params) as the input payload.
            inp = {}
            params = cfg.get("params")
            if isinstance(params, dict):
                inp.update(params)
            return inp

        inp = {}
        for e in upstream:
            out = node_outputs.get(e["source_node_id"])
            if out is None:
                continue
            # UI stores handles as "out:<port>" / "in:<port>" (React-Flow Handle
            # ids). Strip the directional prefix so they match the bare port
            # names used as keys in the source node's output map. Sentinel
            # "output"/"input" (single-port components) are unaffected.
            src_handle = e["source_handle"] or ""
            if isinstance(src_handle, str) and src_handle.startswith("out:"):
                src_handle = src_handle[len("out:"):]
            tgt_handle = e["target_handle"] or ""
            if isinstance(tgt_handle, str) and tgt_handle.startswith("in:"):
                tgt_handle = tgt_handle[len("in:"):]
            # Pick the specific output port via source_handle (empty/"output" =>
            # the whole output object).
            if src_handle and src_handle not in ("output", "out"):
                value = out.get(src_handle, None) if isinstance(out, dict) else out
            else:
                value = out
            if value is None:
                continue
            # Land it under target_handle (empty/"input" => merge all keys).
            if tgt_handle and tgt_handle not in ("input", "in"):
                inp[tgt_handle] = value
            elif isinstance(value, dict):
                inp.update(value)
            else:
                inp["value"] = value
        return inp

    def resolve_node(self, node, plan, log_fn=None):
        """Return (component_root, entry_point) for a node.

        The component definition (``components`` table) is the single source of
        truth for git/branch/ref/entry. ``node.config`` carries only instance
        params (``node.config.params``), so we read the source straight from the
        component row — there is no fallback into the node config (that legacy
        path is gone). ``plan`` is kept for call-site compatibility.
        """
        component_id = node.get("component_id") or ""
        comp = get_component(component_id)
        if not comp:
            raise RuntimeError(f"component {component_id} not found")
        git_url = (comp.get("git_url") or "").strip()
        git_branch = (comp.get("git_branch") or "").strip() or "master"
        git_ref = (comp.get("git_ref") or "").strip() or ""
        entry_point = (comp.get("entry_point") or "").strip() or "run.py"
        component_root = prepare_env(
            git_url, git_branch, config.cache_root(), git_ref=git_ref, log_fn=log_fn
        )
        return component_root, entry_point

    def process(self, exec_id):
        now = lambda: int(time.time() * 1000)
        add_log(exec_id, None, "info", f"Worker {config.worker_id()} claimed execution {exec_id}")

        exec_row = get_execution(exec_id)
        if not exec_row:
            return
        dag_id = exec_row["dag_id"]
        # Replay the frozen plan captured at submit time so a run always uses
        # the config it was launched with, even if the live DAG changed since.
        plan = None
        snapshot = exec_row.get("snapshot")
        if snapshot:
            try:
                plan = json.loads(snapshot)
            except Exception:
                plan = None
        if not plan:
            plan = get_dag_plan(dag_id)
        order = self.compute_order(plan)
        node_map = {n["id"]: n for n in plan["nodes"]}
        node_outputs = {}
        cancel_check = lambda: is_cancel_requested(exec_id)

        for node_id in order:
            if self.stop:
                upsert_node_execution(exec_id, node_id, "cancelled", completed_at_ms=now())
                set_execution_status(exec_id, "cancelled", now())
                return

            node = node_map.get(node_id)
            if node is None:
                continue

            def _log(kind, message):
                add_log(exec_id, node_id, kind, message)

            try:
                component_root, entry_point = self.resolve_node(node, plan, log_fn=_log)
            except Exception as e:
                upsert_node_execution(
                    exec_id, node_id, "failed", completed_at_ms=now(), error=str(e)[:2000]
                )
                add_log(exec_id, node_id, "error", f"Resolve failed: {e}")
                set_execution_status(exec_id, "failed", now())
                return

            upsert_node_execution(exec_id, node_id, "preparing", started_at_ms=now())
            add_log(exec_id, node_id, "info", f"Preparing environment for node {node_id}")

            if cancel_check():
                upsert_node_execution(exec_id, node_id, "cancelled", completed_at_ms=now())
                set_execution_status(exec_id, "cancelled", now())
                return

            upsert_node_execution(exec_id, node_id, "running", started_at_ms=now())
            add_log(exec_id, node_id, "info", f"Running node {node_id}")

            inp = self.build_input(node, plan, node_outputs)
            work_dir = os.path.join(config.cache_root(), "runs", exec_id, node_id)

            result = run_node(
                component_root,
                entry_point,
                inp,
                work_dir,
                cancel_check=cancel_check,
                poll=config.cancel_poll(),
                log_fn=_log,
            )

            if result["cancelled"]:
                upsert_node_execution(exec_id, node_id, "cancelled", completed_at_ms=now())
                set_execution_status(exec_id, "cancelled", now())
                return

            if not result["success"]:
                err = (result["stderr"] or "")[:2000]
                upsert_node_execution(
                    exec_id, node_id, "failed", completed_at_ms=now(), error=err
                )
                add_log(exec_id, node_id, "error", f"Node failed: {err[:500]}")
                set_execution_status(exec_id, "failed", now())
                return

            node_outputs[node_id] = result["output_value"]
            upsert_node_execution(
                exec_id,
                node_id,
                "success",
                completed_at_ms=now(),
                output_path=result["output_path"],
                outputs=result["output_value"],
            )
            add_log(exec_id, node_id, "info", "Node succeeded")

        set_execution_status(exec_id, "success", now(), outputs=node_outputs)
        add_log(exec_id, None, "info", "Execution succeeded")


def main():
    ensure_executor_schema()
    worker = Worker()
    print(
        f"[engine_executor] worker {config.worker_id()} started; "
        f"db={config.db_path()}; poll={config.poll_interval()}s",
        flush=True,
    )
    while not worker.stop:
        exec_id = claim_next()
        if exec_id:
            try:
                worker.process(exec_id)
            except Exception as e:  # pragma: no cover - safety net
                set_execution_status(exec_id, "failed", int(time.time() * 1000))
                add_log(exec_id, None, "error", f"Unhandled worker error: {e}")
        else:
            time.sleep(config.poll_interval())
    print("[engine_executor] worker stopped", flush=True)


if __name__ == "__main__":
    main()
