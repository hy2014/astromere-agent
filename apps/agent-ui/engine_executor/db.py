"""Thin SQLite access layer for the engine_executor worker.

The worker is a *consumer* in a producer-consumer setup: Rust (or the cron
scheduler) inserts a `dag_executions` row with status ``submit``; this module
lets the worker atomically *claim* it, drive the per-node state machine, and
persist logs. It talks to the exact same SQLite file the Rust/Tauri app uses
(WAL mode), so no extra message broker is needed.
"""

import json
import os
import sqlite3
import time

import config


def connect() -> sqlite3.Connection:
    path = config.db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path, timeout=15)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.row_factory = sqlite3.Row
    return conn


def ensure_executor_schema() -> None:
    """Idempotently make sure the tables/columns this worker needs exist.

    Core tables (dags, dag_nodes, execution_logs, ...) are created by the Rust
    app on open; here we only guarantee the executor-specific pieces, mirroring
    the project's "CREATE TABLE IF NOT EXISTS / add column if missing" rule so
    we never drop data.
    """
    conn = connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS node_executions (
                id TEXT PRIMARY KEY,
                execution_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at_ms INTEGER,
                completed_at_ms INTEGER,
                output_path TEXT,
                outputs TEXT,
                error TEXT
            );
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_node_executions_execution "
            "ON node_executions(execution_id);"
        )
        ne_cols = {row[1] for row in conn.execute("PRAGMA table_info(node_executions)")}
        if "outputs" not in ne_cols:
            conn.execute("ALTER TABLE node_executions ADD COLUMN outputs TEXT")
        cols = {row[1] for row in conn.execute("PRAGMA table_info(dag_executions)")}
        if "worker_id" not in cols:
            conn.execute("ALTER TABLE dag_executions ADD COLUMN worker_id TEXT")
        if "claimed_at_ms" not in cols:
            conn.execute("ALTER TABLE dag_executions ADD COLUMN claimed_at_ms INTEGER")
        conn.commit()
    finally:
        conn.close()


def claim_next(exclude_dag_ids=None):
    """Atomically claim one ``submit`` execution.

    Uses a single conditional UPDATE guarded by ``status='submit'`` and checks
    ``rowcount`` so two workers can never claim the same job (optimistic
    locking). Returns the execution id, or ``None`` if nothing is pending.

    ``exclude_dag_ids`` (iterable of dag ids) lets the in-process scheduler skip
    executions whose DAG already has a run in flight — this is the per-DAG mutual
    exclusion that keeps two runs of the same DAG from interleaving. The SQLite
    optimistic lock above is the cross-instance safety net; the in-process check
    is the precise guarantee.
    """
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, dag_id FROM dag_executions WHERE status='submit' "
            "ORDER BY started_at_ms ASC"
        ).fetchall()
        if not rows:
            return None
        chosen = None
        for row in rows:
            if exclude_dag_ids and row["dag_id"] in exclude_dag_ids:
                continue
            chosen = row
            break
        if chosen is None:
            return None
        exec_id = chosen["id"]
        cur = conn.execute(
            "UPDATE dag_executions SET status='accepted', worker_id=?, claimed_at_ms=? "
            "WHERE id=? AND status='submit'",
            (config.worker_id(), int(time.time() * 1000), exec_id),
        )
        if cur.rowcount != 1:
            return None
        conn.commit()
        return exec_id
    finally:
        conn.close()


def get_execution(exec_id):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM dag_executions WHERE id=?", (exec_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_component(component_id):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT id, entry_point, git_url, git_branch, git_ref, workspace_root, config_schema "
            "FROM components WHERE id=?",
            (component_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_dag_plan(dag_id):
    """Return the execution_order, nodes and edges for a DAG."""
    conn = connect()
    try:
        dag = conn.execute(
            "SELECT id, execution_order FROM dags WHERE id=?", (dag_id,)
        ).fetchone()
        nodes = conn.execute(
            "SELECT id, component_id, config FROM dag_nodes WHERE dag_id=?", (dag_id,)
        ).fetchall()
        edges = conn.execute(
            "SELECT source_node_id, target_node_id, source_handle, target_handle "
            "FROM dag_edges WHERE dag_id=?",
            (dag_id,),
        ).fetchall()
        return {
            "execution_order": dag["execution_order"] if dag else None,
            "nodes": [dict(n) for n in nodes],
            "edges": [dict(e) for e in edges],
        }
    finally:
        conn.close()


def set_execution_status(exec_id, status, completed_at_ms=None, outputs=None):
    conn = connect()
    try:
        if outputs is not None:
            conn.execute(
                "UPDATE dag_executions SET status=?, completed_at_ms=?, outputs=? WHERE id=?",
                (status, completed_at_ms, json.dumps(outputs), exec_id),
            )
        else:
            conn.execute(
                "UPDATE dag_executions SET status=?, completed_at_ms=? WHERE id=?",
                (status, completed_at_ms, exec_id),
            )
        conn.commit()
    finally:
        conn.close()


def upsert_node_execution(
    exec_id,
    node_id,
    status,
    started_at_ms=None,
    completed_at_ms=None,
    output_path=None,
    outputs=None,
    error=None,
):
    conn = connect()
    try:
        existing = conn.execute(
            "SELECT id FROM node_executions WHERE execution_id=? AND node_id=?",
            (exec_id, node_id),
        ).fetchone()
        if existing:
            # Only overwrite columns that are explicitly provided. This keeps the
            # original started_at_ms intact when a later transition (e.g. success)
            # omits it, instead of clobbering it with NULL.
            sets = ["status=?"]
            params = [status]
            if started_at_ms is not None:
                sets.append("started_at_ms=?")
                params.append(started_at_ms)
            if completed_at_ms is not None:
                sets.append("completed_at_ms=?")
                params.append(completed_at_ms)
            if output_path is not None:
                sets.append("output_path=?")
                params.append(output_path)
            if outputs is not None:
                sets.append("outputs=?")
                params.append(json.dumps(outputs))
            if error is not None:
                sets.append("error=?")
                params.append(error)
            params.append(exec_id)
            params.append(node_id)
            conn.execute(
                f"UPDATE node_executions SET {', '.join(sets)} "
                "WHERE execution_id=? AND node_id=?",
                params,
            )
        else:
            nid = f"{exec_id}:{node_id}"
            conn.execute(
                "INSERT INTO node_executions "
                "(id, execution_id, node_id, status, started_at_ms, completed_at_ms, output_path, outputs, error) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    nid,
                    exec_id,
                    node_id,
                    status,
                    started_at_ms,
                    completed_at_ms,
                    output_path,
                    json.dumps(outputs) if outputs is not None else None,
                    error,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def add_log(exec_id, node_id, level, message):
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO execution_logs (execution_id, node_id, level, message, timestamp_ms) "
            "VALUES (?,?,?,?,?)",
            (exec_id, node_id, level, message, int(time.time() * 1000)),
        )
        conn.commit()
    finally:
        conn.close()


def is_cancel_requested(exec_id) -> bool:
    row = get_execution(exec_id)
    return bool(row and row.get("status") == "cancel_requested")
