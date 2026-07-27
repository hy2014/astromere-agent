"""Configuration for the engine_executor worker.

All knobs are read from environment variables so the worker can be pointed at
any database / cache location without code changes (useful for tests and for
running against a production DB on another machine).
"""

import os


def db_path() -> str:
    """Path to the shared SQLite database (same file the Rust/Tauri app uses)."""
    p = os.environ.get("AGENT_UI_DB_PATH")
    if p:
        return p
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".agent-ui", "sqlite", "agent-ui.db")


def poll_interval() -> float:
    """Seconds to wait between polls when no job is available."""
    try:
        return float(os.environ.get("ENGINE_EXECUTOR_POLL_INTERVAL", "1.0"))
    except ValueError:
        return 1.0


def cache_root() -> str:
    """Root directory for cached git clones and per-run working dirs."""
    p = os.environ.get("ENGINE_EXECUTOR_CACHE_ROOT")
    if p:
        return p
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".agent-ui", "component-cache")


def worker_id() -> str:
    """Stable identifier written to claimed executions (for multi-worker setups)."""
    return os.environ.get("ENGINE_EXECUTOR_WORKER_ID", f"worker-{os.getpid()}")


def cancel_poll() -> float:
    """How often (seconds) to check for a cancel request while a node runs."""
    try:
        return float(os.environ.get("ENGINE_EXECUTOR_CANCEL_POLL", "0.25"))
    except ValueError:
        return 0.25


def log_dir() -> str:
    """Root directory for per-execution component logs written to disk.

    The worker streams each node's stdout/stderr to
    ``<log_dir>/<execution_id>/<node_id>.log`` (one file per node, untruncated)
    so the UI can page through the *full* log instead of the truncated DB copy.
    Override with ``AGENT_UI_LOG_DIR`` (the Rust server sets this to match the
    directory it serves the log files from).
    """
    p = os.environ.get("AGENT_UI_LOG_DIR")
    if p:
        return p
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "."
    return os.path.join(home, ".agent-ui", "logs")
