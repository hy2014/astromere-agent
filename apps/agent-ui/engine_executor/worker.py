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
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

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
        # Per-DAG mutual exclusion (in-process precise guarantee). Two runs of
        # the same dag never interleave: the scheduler only claims an exec whose
        # dag_id is not in this set. The SQLite optimistic lock in claim_next is
        # the cross-instance safety net.
        self.running_dags = set()
        self.dag_lock = threading.Lock()
        # Global cap on concurrently-running component subprocesses. This is the
        # single real throttle (see docs/parallel-execution.md §2/§4). A node
        # acquires it right before launching its entry_point Popen and releases
        # in `finally`, so the number of live component processes never exceeds
        # min(CPU, 8) across ALL concurrently-running DAG runs.
        self.component_sem = threading.Semaphore(max(1, min(os.cpu_count() or 4, 8)))
        # In-process thread pool: the scheduler submits one `process` per claimed
        # DAG run, so multiple DAG runs execute concurrently. (the worker process
        # count is always 1; crash isolation is handled by the Rust side.)
        self.executor = ThreadPoolExecutor(
            max_workers=max(1, min(os.cpu_count() or 4, 8)),
            thread_name_prefix="dag-run",
        )
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
    def compute_layers(plan):
        """Group node ids into topological layers.

        Every node in a layer is independent of the others in the same layer
        (no edges between them), so the layer can be executed concurrently.
        Layers themselves run strictly in order, which is what makes the
        per-layer concurrency safe: by the time a downstream layer starts, all
        of its upstream nodes have already settled.
        """
        nodes = plan.get("nodes") or []
        edges = plan.get("edges") or []
        node_ids = {n["id"] for n in nodes}
        indeg = {n["id"]: 0 for n in nodes}
        adj = {n["id"]: [] for n in nodes}
        for e in edges:
            s, t = e.get("source_node_id"), e.get("target_node_id")
            if s in node_ids and t in node_ids:
                adj[s].append(t)
                indeg[t] += 1
        layers = []
        remaining = dict(indeg)
        ready = sorted(nid for nid, d in remaining.items() if d == 0)
        while ready:
            layers.append(ready)
            nxt = []
            for nid in ready:
                for t in adj[nid]:
                    remaining[t] -= 1
                    if remaining[t] == 0:
                        nxt.append(t)
            ready = sorted(nxt)
        # Any leftover nodes (e.g. due to a cycle) are dumped into a final layer
        # so we never silently drop them. Cycles are a graph-authoring error and
        # are not expected in practice.
        leftover = sorted(nid for nid, d in remaining.items() if d > 0)
        if leftover:
            layers.append(leftover)
        return layers

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
        """Return (component_root, entry_point, python_path) for a node.

        The component definition (``components`` table) is the single source of
        truth for git/branch/ref/entry. ``node.config`` carries only instance
        params (``node.config.params``), and the "use this exact Python
        interpreter" setting is one of those instance params (key
        ``system.python_path``, value = absolute path to the python executable)
        — set per-node from the "系统配置" tab, NOT a column on the component.
        ``plan`` is kept for call-site compatibility.
        """
        component_id = node.get("component_id") or ""
        comp = get_component(component_id)
        if not comp:
            raise RuntimeError(f"component {component_id} not found")
        git_url = (comp.get("git_url") or "").strip()
        git_branch = (comp.get("git_branch") or "").strip() or "master"
        git_ref = (comp.get("git_ref") or "").strip() or ""
        entry_point = (comp.get("entry_point") or "").strip() or "run.py"
        # "Specify Python interpreter path" is a node-level system config, stored
        # in node.config.params (key=system.python_path, value=absolute path to
        # the python executable, e.g. ~/miniconda3/bin/python3.10). When set, run
        # directly with that interpreter (no venv, no dependency install), reusing
        # the deps already present in its environment (e.g. the infra package from
        # astromere-infra installed editable in conda). When unset, use the default
        # isolated venv.
        params = (node.get("config") or {}).get("params") or {}
        python_path = params.get("system.python_path")
        python_path = python_path.strip() if isinstance(python_path, str) else ""
        component_root = prepare_env(
            git_url, git_branch, config.cache_root(), git_ref=git_ref, log_fn=log_fn
        )
        return component_root, entry_point, python_path

    def process(self, exec_id):
        """Drive one DAG execution through its state machine.

        Concurrency model (docs/parallel-execution.md §2): nodes are grouped
        into topological *layers*; nodes within a layer have no dependency on
        each other and run concurrently on plain threads. Layers run strictly
        in order (we join a whole layer before starting the next), so every
        upstream node has already settled before its downstream reads its
        output. The number of *component subprocesses* running at once is capped
        by ``self.component_sem`` across ALL in-flight DAG runs (the real
        throttle), independent of how many layers/DAGs are in flight.
        """
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
        layers = self.compute_layers(plan)
        node_map = {n["id"]: n for n in plan["nodes"]}
        # Shared across layer threads; writes are guarded by state_lock. Reads of
        # upstream values happen only in later layers (after join => happens-
        # before), so they need no lock.
        node_outputs = {}
        node_status = {}
        state_lock = threading.Lock()
        cancel_event = threading.Event()
        any_failed = False
        cancel_check = lambda: is_cancel_requested(exec_id)

        def run_node_thread(node_id):
            nonlocal any_failed
            node = node_map.get(node_id)
            if node is None:
                return

            def _log(kind, message):
                add_log(exec_id, node_id, kind, message)

            # status gating (branch isolation): if any upstream node (along any
            # incoming edge, data or status) is failed/skipped, skip this node -
            # do not clone/run it, and let the failure continue propagating along
            # the edges. Gating is independent of the port kind - it only looks at
            # upstream node status + the graph's edges (see docs/engine-executor.md).
            upstream_ids = [
                e["source_node_id"] for e in plan["edges"] if e["target_node_id"] == node_id
            ]
            with state_lock:
                upstream_failed = any(node_status.get(uid) == "failed" for uid in upstream_ids)
            if upstream_failed:
                upsert_node_execution(exec_id, node_id, "skipped", completed_at_ms=now())
                add_log(exec_id, node_id, "info", "上游状态为 failed/skipped，本节点跳过")
                with state_lock:
                    node_status[node_id] = "failed"  # skipped => equivalent to failed for downstream
                return

            try:
                component_root, entry_point, python_path = self.resolve_node(node, plan, log_fn=_log)
            except Exception as e:
                upsert_node_execution(
                    exec_id, node_id, "failed", completed_at_ms=now(), error=str(e)[:2000]
                )
                add_log(exec_id, node_id, "error", f"Resolve failed: {e}")
                # branch isolation: on resolve failure, only mark this node; do not abort the whole DAG.
                with state_lock:
                    node_status[node_id] = "failed"
                    any_failed = True
                return

            upsert_node_execution(exec_id, node_id, "preparing", started_at_ms=now())
            add_log(exec_id, node_id, "info", f"Preparing environment for node {node_id}")
            _log("info", f"节点解析: 组件={node.get('component_id') or ''} 入口={entry_point} "
                          f"解释器={python_path or '自动探测'} 根目录={component_root}")

            if cancel_event.is_set() or self.stop:
                upsert_node_execution(exec_id, node_id, "cancelled", completed_at_ms=now())
                cancel_event.set()
                return

            upsert_node_execution(exec_id, node_id, "running", started_at_ms=now())
            add_log(exec_id, node_id, "info", f"Running node {node_id}")

            inp = self.build_input(node, plan, node_outputs)
            if inp:
                _log("info", f"构建输入: 键={list(inp.keys())}")
            else:
                _log("info", "构建输入: 空（无上游、无实例参数）")
            work_dir = os.path.join(config.cache_root(), "runs", exec_id, node_id)

            # Global concurrency semaphore: caps "number of concurrently running
            # component subprocesses ≤ min(CPU,8)". This is the real throttle,
            # spanning all in-flight DAG runs (see docs/parallel-execution.md §2/§4).
            self.component_sem.acquire()
            try:
                result = run_node(
                    component_root,
                    entry_point,
                    inp,
                    work_dir,
                    cancel_check=lambda: cancel_check() or cancel_event.is_set() or self.stop,
                    poll=config.cancel_poll(),
                    log_fn=_log,
                    python_path=python_path,
                )
            finally:
                self.component_sem.release()

            if result["cancelled"] or cancel_event.is_set():
                upsert_node_execution(exec_id, node_id, "cancelled", completed_at_ms=now())
                cancel_event.set()
                return

            if not result["success"]:
                err = (result["stderr"] or "")[:2000]
                upsert_node_execution(
                    exec_id, node_id, "failed", completed_at_ms=now(), error=err
                )
                add_log(exec_id, node_id, "error", f"Node failed: {err[:500]}")
            # branch isolation: a node failure no longer aborts the whole DAG -
            # mark this node and let downstream nodes skip via status gating,
            # while other dependency-free branches run to completion normally
            # (see docs/engine-executor.md "status gating").
                with state_lock:
                    node_status[node_id] = "failed"
                    any_failed = True
                return

            with state_lock:
                node_outputs[node_id] = result["output_value"]
                node_status[node_id] = "success"
            upsert_node_execution(
                exec_id,
                node_id,
                "success",
                completed_at_ms=now(),
                output_path=result["output_path"],
                outputs=result["output_value"],
            )
            add_log(exec_id, node_id, "info", "Node succeeded")

        for layer in layers:
            if self.stop or cancel_event.is_set():
                break
            threads = []
            for node_id in layer:
                t = threading.Thread(target=run_node_thread, args=(node_id,), name=f"node-{node_id}")
                threads.append(t)
                t.start()
            for t in threads:
                t.join()
            if self.stop or cancel_event.is_set():
                break

        # Wrap-up: on cancel/stop => unstarted nodes are marked cancelled; otherwise success/failed is decided by any_failed.
        if cancel_event.is_set() or self.stop:
            for nid in node_map:
                with state_lock:
                    st = node_status.get(nid)
                if st is None:
                    upsert_node_execution(exec_id, nid, "cancelled", completed_at_ms=now())
            set_execution_status(exec_id, "cancelled", now())
            add_log(exec_id, None, "info", "Execution cancelled")
            return

        final = "failed" if any_failed else "success"
        set_execution_status(exec_id, final, now(), outputs=node_outputs)
        add_log(exec_id, None, "info", f"Execution {final}")

    def _run_wrapped(self, exec_id, dag_id):
        """Run ``process`` on an executor thread and always release the per-DAG
        mutex afterwards so the same DAG can be claimed again.
        """
        try:
            self.process(exec_id)
        finally:
            if dag_id is not None:
                with self.dag_lock:
                    self.running_dags.discard(dag_id)


def main():
    ensure_executor_schema()
    worker = Worker()
    print(
        f"[engine_executor] worker {config.worker_id()} started; "
        f"db={config.db_path()}; poll={config.poll_interval()}s",
        flush=True,
    )
    # Concurrent scheduler: claim one exec at a time, but instead of running it
    # inline we submit it to the in-process thread pool so MULTIPLE DAG runs
    # execute concurrently (docs/parallel-execution.md §2, solves limitation ①).
    # Per-DAG mutual exclusion (claim_next exclude_dag_ids + running_dags set)
    # guarantees two runs of the same DAG never interleave.
    try:
        while not worker.stop:
            with worker.dag_lock:
                exclude = set(worker.running_dags)
            exec_id = claim_next(exclude_dag_ids=exclude)
            if exec_id:
                row = get_execution(exec_id)
                dag_id = row["dag_id"] if row else None
                if dag_id is not None:
                    with worker.dag_lock:
                        worker.running_dags.add(dag_id)
                worker.executor.submit(worker._run_wrapped, exec_id, dag_id)
            else:
                time.sleep(config.poll_interval())
    finally:
        # Graceful shutdown: stop claiming new work and let in-flight runs finish.
        # (Crash recovery / orphan reaping is a separate follow-up, see docs.)
        worker.executor.shutdown(wait=True)
        print("[engine_executor] worker stopped", flush=True)


if __name__ == "__main__":
    main()
