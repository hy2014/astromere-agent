"""agent-ui 组件 SDK —— 平台 I/O 契约的客户端。

契约本体是**环境变量**（由 agent-ui 的 runner 在执行组件时注入）；本包只是
Python 侧的便利封装。它随 worker 同源同版本发布，组件仓库不需要 vendor 它、
也不需要写进 requirements.txt；非 Python 组件直接读环境变量即可。

注入的环境变量：

    AGENT_UI_INPUT_PATH         输入 JSON 路径，内容 {端口名: 值}
    AGENT_UI_OUTPUT_PATH        输出 JSON 路径，组件回写 {端口名: 值}
    AGENT_UI_OUTPUT_DATA_DIRS   输出目录映射 {端口名: 目录}，由平台分配
    AGENT_UI_SDK_PATH           本包所在目录（非 Python 组件读它）

端口值形态（见 agent-ui `docs/engine-executor.md`「端口值契约」）：

    裸路径字符串            "/abs/a.csv"
    文件卡片                {"path": "/abs/a", "format": "parquet"}
    上述两者的列表（可混用）  [...]

单元素列表与单值**语义等价**——调用方用 :func:`read_input_cards` 归一化后逐项
处理即可，不需要判断类型。路径可以是常规文件，也可以是目录（如按时序分区的
`month=YYYYMM/`）；pandas 的 ``read_parquet`` 对两者写法相同。

逐项读表（细粒度、内存只驻留一份）::

    for card in read_input_cards("out_features"):
        df = read_as_df_from_card(card)
        ...  # 逐项聚合

只要路径（想自己用别的库读）用 :func:`read_input_files`。
"""

import json
import os

__all__ = [
    "read_input_port",
    "read_input_cards",
    "read_input_files",
    "read_as_df_from_card",
    "resolve_output_dir",
    "resolve_db_connection",
]


def _load_input():
    """读取输入 JSON；缺失或损坏时返回空 dict（不抛异常）。"""
    path = os.environ.get("AGENT_UI_INPUT_PATH")
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def read_input_port(name):
    """读取输入端口 ``name`` 的原始值；缺失返回 ``None``。

    需要自己处理形态时使用；多数场景应直接用 :func:`read_input_cards`。
    """
    return _load_input().get(name)


def read_input_cards(name):
    """读取输入端口 ``name`` 并归一化为**产物列表** ``[{path, format}, ...]``。

    接受任意端口值形态（裸路径 / 文件卡片 / 列表，可混用）。单值包成单元素
    列表，因此调用方永远只需 ``for card in ...``，不写 ``isinstance`` 分支。
    裸路径按扩展名补 format。无法识别的条目会被跳过（不是文件的东西不该出现
    在文件端口上）。
    """
    return _normalize_cards(read_input_port(name))


def read_input_files(name):
    """读取输入端口 ``name`` 并归一化为**路径列表**。

    只要路径、不需要 format 时使用（例如想自己用 pyarrow dataset 读）。
    """
    return [card["path"] for card in read_input_cards(name)]


def _normalize_cards(value):
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    cards = []
    for item in items:
        if isinstance(item, str):
            if item:
                cards.append({"path": item, "format": _guess_format(item)})
        elif isinstance(item, dict):
            path = item.get("path")
            if isinstance(path, str) and path:
                declared = item.get("format")
                cards.append({
                    "path": path,
                    "format": declared if isinstance(declared, str) and declared
                    else _guess_format(path),
                })
    return cards


def _guess_format(path):
    """裸路径按扩展名推 format；目录推不出来时返回空串（由读取方明确报错）。"""
    lower = path.lower()
    if lower.endswith(".csv"):
        return "csv"
    if lower.endswith((".jsonl", ".json")):
        return "json"
    if lower.endswith((".parquet", ".pq", ".parq")):
        return "parquet"
    return ""


def read_as_df_from_card(card):
    """把一个产物（card: ``{path, format}``）读成 DataFrame。

    按 ``format`` 分派：parquet / csv / json。parquet 对文件和目录写法相同
    （目录走 hive 分区发现）。format 不认识或不是表格数据 → 抛 ``ValueError``。
    """
    import pandas as pd  # 懒加载：SDK 本身不硬依赖 pandas

    path = card.get("path")
    fmt = card.get("format")
    if fmt == "parquet":
        return pd.read_parquet(path)
    if fmt == "csv":
        return pd.read_csv(path)
    if fmt == "json":
        return pd.read_json(path, lines=str(path).lower().endswith(".jsonl"))
    raise ValueError(f"产物 format={fmt!r} 不是表格数据，读不成 DataFrame: {path}")


def _agent_home():
    """平台数据目录：AGENT_UI_HOME 优先，默认 ~/.agent-ui。"""
    env = os.environ.get("AGENT_UI_HOME")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".agent-ui")


def resolve_db_connection(name):
    """按登记名读共享连接池，返回连接信息 dict（host/port/dbname/user/password）。

    ``~/.agent-ui/databases.json`` 是平台 UI 与组件**共享**的连接登记：平台负责
    写（高级配置「数据库」tab），组件经本函数读。组件自己按返回字段拼连（如
    psycopg2.connect(host=..., port=..., dbname=...)，或拼 postgres:// DSN）。
    找不到 name 或文件不可读 → 抛 ``ValueError``（中文），让组件明确报错，
    而不是拿着空信息去连。
    """
    path = os.path.join(_agent_home(), "databases.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise ValueError(f"无法读取共享连接登记文件 {path}: {e}") from e
    if not isinstance(data, list):
        raise ValueError(f"共享连接登记文件格式不对（应为 JSON 数组）: {path}")
    for reg in data:
        if isinstance(reg, dict) and reg.get("name") == name:
            return {
                "host": reg.get("host") or "",
                "port": reg.get("port") or 5432,
                "dbname": reg.get("dbname") or "",
                "user": reg.get("user") or "",
                "password": reg.get("password") or "",
            }
    raise ValueError(f"共享连接登记里没有「{name}」，请到高级配置的数据库登记中添加")


def resolve_output_dir(port):
    """返回端口 ``port`` 被分配的输出目录；未分配返回 ``None``。

    目录由平台统一分配——可能是业务方配置的落库目录，也可能是平台管理的临时
    目录。组件只负责往里写文件，不需要关心目录的业务语义（这也是「DW 等落库
    配置不泄漏进组件」的实现方式）。脱离 agent-ui 单跑（没有该环境变量）时
    返回 ``None``，组件可回退到自己的临时目录。
    """
    raw = os.environ.get("AGENT_UI_OUTPUT_DATA_DIRS")
    if not raw:
        return None
    try:
        mapping = json.loads(raw)
    except Exception:
        return None
    if not isinstance(mapping, dict):
        return None
    out_dir = mapping.get(port)
    return str(out_dir) if out_dir else None