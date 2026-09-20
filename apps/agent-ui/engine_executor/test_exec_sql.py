"""共享连接登记（SDK `resolve_db_connection`）与 Exec-SQL 语句拆分的单测。"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "sdk"))

from component_sdk import resolve_db_connection  # noqa: E402


def _set_home(home):
    old = os.environ.get("AGENT_UI_HOME")
    os.environ["AGENT_UI_HOME"] = home
    return old


def _restore_home(old):
    if old is None:
        os.environ.pop("AGENT_UI_HOME", None)
    else:
        os.environ["AGENT_UI_HOME"] = old


def _write_registry(tmp, regs):
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, "databases.json"), "w", encoding="utf-8") as f:
        json.dump(regs, f)
    return home


class TestResolveDbConnection(unittest.TestCase):
    def test_resolves_existing_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = _write_registry(
                tmp,
                [{
                    "name": "dw-main", "host": "192.168.1.50", "port": 5999,
                    "dbname": "dw", "user": "etl", "password": "p@ss",
                }],
            )
            old = _set_home(home)
            try:
                info = resolve_db_connection("dw-main")
            finally:
                _restore_home(old)
        self.assertEqual(info, {
            "host": "192.168.1.50", "port": 5999,
            "dbname": "dw", "user": "etl", "password": "p@ss",
        })

    def test_missing_port_defaults_to_5432(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = _write_registry(tmp, [{"name": "x", "host": "h", "user": "u"}])
            old = _set_home(home)
            try:
                info = resolve_db_connection("x")
            finally:
                _restore_home(old)
        self.assertEqual(info["port"], 5432)
        self.assertEqual(info["dbname"], "")

    def test_unknown_name_raises_chinese(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = _write_registry(tmp, [{"name": "dw-main"}])
            old = _set_home(home)
            try:
                with self.assertRaises(ValueError) as ctx:
                    resolve_db_connection("nope")
            finally:
                _restore_home(old)
        self.assertIn("共享连接登记里没有「nope」", str(ctx.exception))

    def test_missing_file_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = _set_home(os.path.join(tmp, "empty-home"))
            try:
                with self.assertRaises(ValueError) as ctx:
                    resolve_db_connection("x")
            finally:
                _restore_home(old)
        self.assertIn("无法读取共享连接登记文件", str(ctx.exception))

    def test_non_list_format_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            os.makedirs(home, exist_ok=True)
            with open(os.path.join(home, "databases.json"), "w", encoding="utf-8") as f:
                json.dump({"name": "x"}, f)
            old = _set_home(home)
            try:
                with self.assertRaises(ValueError) as ctx:
                    resolve_db_connection("x")
            finally:
                _restore_home(old)
        self.assertIn("应为 JSON 数组", str(ctx.exception))


class TestExecSqlSplitStatements(unittest.TestCase):
    def _load(self):
        sys.path.insert(0, os.path.join(HERE, "..", "components", "exec-sql"))
        import importlib
        import run as exec_sql_run
        return importlib.reload(exec_sql_run).split_statements

    def test_splits_and_ignores_comments_and_strings(self):
        split = self._load()
        sql = ("-- 注释; 分号\n"
               "INSERT INTO t VALUES('a;b');\n"
               "/* 块;注释 */ UPDATE t SET x='it''s';\n"
               "SELECT 1")
        self.assertEqual(
            split(sql),
            ["INSERT INTO t VALUES('a;b')", "UPDATE t SET x='it''s'", "SELECT 1"],
        )
        self.assertEqual(split(""), [])
        self.assertEqual(split(";;;"), [])
        self.assertEqual(split("-- only comment;"), [])


class _FakeCur:
    """记录 execute 调用与绑定参数；rowcount 恒为 1。"""
    def __init__(self):
        self.calls = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.calls.append((sql, params))


class TestExecSqlBatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.join(HERE, "..", "components", "exec-sql"))
        cls._sdk_home = (HERE, "sdk")
        cls._old_syspath = list(sys.path)
        sys.path.insert(0, os.path.join(HERE, "sdk"))
        import importlib
        import run as m
        cls.mod = importlib.reload(m)

    @classmethod
    def tearDownClass(cls):
        sys.path[:] = cls._old_syspath
        os.environ.pop("AGENT_UI_INPUT_PATH", None)

    def test_token_binds_each_row_once(self):
        import pandas as pd

        with tempfile.TemporaryDirectory() as tmp:
            df = pd.DataFrame([{"id": 1, "price": 10}, {"id": 2, "price": 20}])
            parquet = os.path.join(tmp, "in.parquet")
            df.to_parquet(parquet)
            with open(os.path.join(tmp, "in.json"), "w", encoding="utf-8") as f:
                json.dump({"t": [{"path": parquet, "format": "parquet"}]}, f)
            os.environ["AGENT_UI_INPUT_PATH"] = os.path.join(tmp, "in.json")

            affected = []
            cur = _FakeCur()
            stmt = "INSERT INTO t(id, price) VALUES ($t.id, $t.price)"
            n = self.mod.execute_statement(cur, stmt, {}, affected)

        self.assertEqual(n, 2)  # 两行 → 执行两次
        self.assertEqual(len(cur.calls), 2)
        sql0, params0 = cur.calls[0]
        self.assertEqual(sql0, "INSERT INTO t(id, price) VALUES (%(p0)s, %(p1)s)")
        self.assertEqual(params0, {"p0": 1, "p1": 10})
        self.assertEqual(cur.calls[1][1], {"p0": 2, "p1": 20})
        self.assertEqual(affected, [1, 1])

    def test_missing_column_raises_chinese(self):
        import pandas as pd

        with tempfile.TemporaryDirectory() as tmp:
            df = pd.DataFrame([{"id": 1, "price": 10}])
            parquet = os.path.join(tmp, "in.parquet")
            df.to_parquet(parquet)
            with open(os.path.join(tmp, "in.json"), "w", encoding="utf-8") as f:
                json.dump({"t": [{"path": parquet, "format": "parquet"}]}, f)
            os.environ["AGENT_UI_INPUT_PATH"] = os.path.join(tmp, "in.json")

            affected = []
            cur = _FakeCur()
            with self.assertRaises(ValueError) as ctx:
                self.mod.execute_statement(
                    cur, "INSERT INTO t(id) VALUES ($t.nope)", {}, affected
                )
        self.assertIn("没有列「nope」", str(ctx.exception))

    def test_missing_input_port_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "in.json"), "w", encoding="utf-8") as f:
                json.dump({}, f)
            os.environ["AGENT_UI_INPUT_PATH"] = os.path.join(tmp, "in.json")
            affected = []
            with self.assertRaises(ValueError) as ctx:
                self.mod.execute_statement(
                    _FakeCur(), "INSERT INTO t(id) VALUES ($t.id)", {}, affected
                )
        self.assertIn("没有数据文件", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()