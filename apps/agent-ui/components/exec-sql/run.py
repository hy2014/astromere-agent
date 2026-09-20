"""Exec-SQL 组件：在平台登记的数据库上执行自由 SQL。

参数（随 input JSON 顶层传入，见 worker build_input）：
  connection  共享连接登记里的连接名（组件经 SDK ``resolve_db_connection``
              读取该共享登记，拿到 host/port/user/password 自己连库）
  database    目标库名
  sql         要执行的 SQL，可含多条语句（分号分隔，单事务）

输出端口 update_status：字符串摘要（执行了几条语句、共影响多少行）。

本地冒烟（脱离 agent-ui）：先按 SDK 的路径写好共享登记文件，再
  echo '{"connection":"x","database":"db","sql":"SELECT 1"}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
"""

import json
import os
import sys

from component_sdk import resolve_db_connection

OUTPUT_PORT = "update_status"


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def split_statements(sql: str) -> list[str]:
    """按分号拆多条语句；跳过 -- 行注释、/* 块注释 */，字符串字面量原样保留。"""
    out: list[str] = []
    current: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            current.append(c)
            i += 1
            while i < n:
                current.append(sql[i])
                if sql[i] == "'":
                    i += 1
                    if i < n and sql[i] == "'":
                        current.append(sql[i])
                        i += 1
                        continue
                    break
                i += 1
        elif c == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and sql[i + 1] == "*":
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i = min(i + 2, n)
        elif c == ";":
            stmt = "".join(current).strip()
            if stmt:
                out.append(stmt)
            current = []
            i += 1
        else:
            current.append(c)
            i += 1
    stmt = "".join(current).strip()
    if stmt:
        out.append(stmt)
    return out


def run(data: dict) -> int:
    connection = str(data.get("connection") or "").strip()
    database = str(data.get("database") or "").strip()
    sql = str(data.get("sql") or "").strip()

    if not connection:
        return fail("缺少参数 connection（共享连接登记里的连接名）。")
    if not database:
        return fail("缺少参数 database（目标库名）。")
    if not sql:
        return fail("缺少参数 sql。")

    try:
        info = resolve_db_connection(connection)
    except Exception as exc:
        return fail(str(exc))

    statements = split_statements(sql)
    if not statements:
        return fail("sql 里没有可执行的语句。")

    try:
        import psycopg2
    except ImportError:
        return fail("缺少依赖 psycopg2-binary（见 requirements.txt）。")

    try:
        conn = psycopg2.connect(
            host=info["host"] or None,
            port=info["port"],
            dbname=database,
            user=info["user"] or None,
            password=info["password"] or None,
        )
    except Exception as exc:
        return fail(f"连接数据库失败: {exc}")

    affected = 0
    try:
        with conn:  # 单事务：全部成功才提交，任何一条失败整体回滚
            with conn.cursor() as cur:
                for i, stmt in enumerate(statements, 1):
                    cur.execute(stmt)
                    if cur.rowcount and cur.rowcount > 0:
                        affected += cur.rowcount
                    print(f"[{i}/{len(statements)}] OK: {stmt[:80]}...", flush=True)
    except Exception as exc:
        return fail(f"SQL 执行失败（已回滚全部语句）: {exc}")

    summary = f"Exec-SQL 完成：{len(statements)} 条语句，共影响 {affected} 行。"
    output_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if output_path:
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump({OUTPUT_PORT: summary}, fh, ensure_ascii=False, indent=2)
    print(summary, flush=True)
    return 0


def main() -> int:
    input_path = os.environ.get("AGENT_UI_INPUT_PATH")
    data: dict = {}
    if input_path and os.path.exists(input_path):
        try:
            with open(input_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as exc:
            return fail(f"读取输入失败 {input_path}: {exc}")
    if not isinstance(data, dict):
        return fail("input 必须是 JSON object。")
    return run(data)


if __name__ == "__main__":
    sys.exit(main())
