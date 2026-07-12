"""Unit test: engine db.get_component returns the component's git columns.

The component is the configuration truth-source, so the Python worker must be
able to read git_url / git_branch / git_ref from the `components` row (the
Rust `build_snapshot` merges them into the frozen plan, and `worker.resolve_node`
prefers them). Run directly:

    cd engine_executor && python3 tests/test_db_git.py
"""
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402


def main() -> None:
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, "agent-ui-test.db")
    os.environ["AGENT_UI_DB_PATH"] = db_path

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE components (
            id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT,
            workspace_root TEXT, git_url TEXT, git_branch TEXT, git_ref TEXT,
            entry_point TEXT, input_schema TEXT, output_schema TEXT,
            config_schema TEXT, tags TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
        )
        """
    )
    conn.execute(
        "INSERT INTO components (id, name, status, workspace_root, git_url, "
        "git_branch, git_ref, entry_point, input_schema, output_schema, "
        "config_schema, tags, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("c1", "demo", "draft", "", "git@x/y.git", "main", "v1", "run.py",
         "{}", "{}", "[]", "[]", 0, 0),
    )
    conn.commit()
    conn.close()

    comp = db.get_component("c1")
    assert comp is not None, "component not found"
    assert comp["git_url"] == "git@x/y.git", comp
    assert comp["git_branch"] == "main", comp
    assert comp["git_ref"] == "v1", comp
    assert comp["entry_point"] == "run.py", comp
    print("PASS: db.get_component returns git columns")


if __name__ == "__main__":
    main()
