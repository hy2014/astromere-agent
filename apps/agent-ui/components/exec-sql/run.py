"""Exec-SQL 组件：在平台登记的数据库上执行自由 SQL。

参数（随 input JSON 顶层传入，见 worker build_input）：
  connection  共享连接登记里的连接名（组件经 SDK ``resolve_db_connection``
              读取该共享登记，拿到 host/port/user/password 自己连库）
  database    目标库名
  sql         要执行的 SQL，可含多条语句（分号分隔，单事务）

输入端口：SQL 里可用 ``$<端口名>.<列名>`` 引用上游文件的一列。这条语句会
对该输入端口的**每个文件、每一行各执行一次**，把该行的 ``<列名>`` 值作为
绑定参数（exec batch）。无 ``$`` 的语句原样执行一次。多语句全在一个事务里。

  INSERT INTO t(id, price) VALUES ($t.id, $t.price)
      ON CONFLICT(id) DO UPDATE SET price = EXCLUDED.price

输出端口 exec-status：本次执行的摘要文件（JSON）。

本地冒烟（脱离 agent-ui）：先按 SDK 的路径写好共享登记文件，再
  echo '{"connection":"x","database":"db","sql":"SELECT 1"}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
"""

import json
import os
import re
import sys

from component_sdk import read_input_cards, resolve_db_connection, resolve_output_dir

OUTPUT_PORT = "exec-status"

# $<端口名>.<列名>；两端都是合法标识符
TOKEN_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)")


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


def _py(v):
    """pandas/numpy 标量 → 原生 Python 值（psycopg2 绑定用）。"""
    import pandas as pd

    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            return v
    return v


def _load_input_rows(port: str):
    """读取输入端口所有文件的全部行，转成 ``[{列名: 原生值}, ...]`` 列表。

    端口无文件或文件读空 → 抛 ValueError（中文），不让语句静默空跑。
    """
    import pandas as pd

    cards = read_input_cards(port)
    if not cards:
        raise ValueError(f"输入端口「{port}」没有数据文件。")
    rows = []
    for card in cards:
        df = pd.read_parquet(card["path"]) if card["format"] == "parquet" else pd.read_csv(card["path"])
        for rec in df.to_dict("records"):
            rows.append({k: _py(v) for k, v in rec.items()})
    if not rows:
        raise ValueError(f"输入端口「{port}」的文件没有任何行。")
    return rows, cards


def execute_statement(cur, stmt: str, data: dict, affected: list):
    """执行一条语句；含 $端口.列 的语句逐行 batch 绑定执行。"""
    tokens = list(dict.fromkeys(TOKEN_RE.findall(stmt)))  # 去重的 (端口, 列)
    if not tokens:
        cur.execute(stmt)
        rc = cur.rowcount
        if rc and rc > 0:
            affected.append(rc)
        return 0

    ports = {t[0] for t in tokens}
    if len(ports) > 1:
        raise ValueError(
            f"一条语句暂只支持引用同一输入端口的列，这里引用了 {sorted(ports)}"
        )
    port = ports.pop()
    rows, _cards = _load_input_rows(port)

    # 参数名按令牌在 tokens 里的下标；同名令牌复用同名参数
    def _repl(m):
        t = (m.group(1), m.group(2))
        idx = tokens.index(t)
        return f"%({f'p{idx}'})s"

    converted = TOKEN_RE.sub(_repl, stmt)
    for row in rows:
        row_params = {f"p{i}": row.get(col) for i, (_, col) in enumerate(tokens)}
        for i, (port_name, col) in enumerate(tokens):
            if col not in row:
                raise ValueError(
                    f"输入端口「{port_name}」的文件里没有列「{col}」（现有列：{sorted(row)}）"
                )
            row_params[f"p{i}"] = row[col]
        cur.execute(converted, row_params)
        rc = cur.rowcount
        if rc and rc > 0:
            affected.append(rc)
    return len(rows)


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

    affected: list[int] = []
    row_counts: list[int] = []
    try:
        with conn:  # 单事务：全部成功才提交，任何一条失败整体回滚
            with conn.cursor() as cur:
                for i, stmt in enumerate(statements, 1):
                    n = execute_statement(cur, stmt, data, affected)
                    row_counts.append(n)
                    print(f"[{i}/{len(statements)}] OK: {stmt[:80]}...", flush=True)
    except Exception as exc:
        return fail(f"SQL 执行失败（已回滚全部语句）: {exc}")

    n_affected = sum(affected)
    summary = f"Exec-SQL 完成：{len(statements)} 条语句，共影响 {n_affected} 行。"
    output_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    out_dir = resolve_output_dir(OUTPUT_PORT)
    if out_dir and output_path:
        os.makedirs(out_dir, exist_ok=True)
        report = os.path.join(out_dir, "status.json")
        with open(report, "w", encoding="utf-8") as fh:
            json.dump({"message": summary, "affected_rows": n_affected}, fh, ensure_ascii=False, indent=2)
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump({OUTPUT_PORT: [{"path": report, "format": "json"}]}, fh, ensure_ascii=False, indent=2)
    elif output_path:
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
