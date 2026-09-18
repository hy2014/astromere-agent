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

单元素列表与单值**语义等价**——调用方用 :func:`read_input_files` 归一化后
逐项读取即可，不需要判断类型。路径可以是常规文件，也可以是目录（如按时序
分区的 `month=YYYYMM/`）；pandas 的 ``read_parquet`` 对两者写法相同。
"""

import json
import os

__all__ = ["read_input_port", "read_input_files", "resolve_output_dir"]


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

    需要自己处理形态时使用；多数场景应直接用 :func:`read_input_files`。
    """
    return _load_input().get(name)


def read_input_files(name):
    """读取输入端口 ``name`` 并归一化为**路径列表**。

    接受任意端口值形态（裸路径 / 文件卡片 / 列表，可混用）。单值会包成单元素
    列表，因此调用方永远只需 ``for path in read_input_files(...)``，不写
    ``isinstance`` 分支。无法识别的条目会被跳过（不是路径的东西不该出现在
    文件端口上）。
    """
    return _normalize_paths(read_input_port(name))


def _normalize_paths(value):
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    paths = []
    for item in items:
        if isinstance(item, str):
            if item:
                paths.append(item)
        elif isinstance(item, dict):
            path = item.get("path")
            if isinstance(path, str) and path:
                paths.append(path)
    return paths


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