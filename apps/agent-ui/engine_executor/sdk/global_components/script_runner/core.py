"""script_runner 核心执行逻辑。

流程：读平台注入的 input.json → 按必填的 ``script.module`` /
``script.class`` 定位业务任务类 → 无参实例化 → 把节点 ``args`` 解析成
参数字典，按 ``run`` 的签名调用 ``run(params)`` 或 ``run(params, ctx)``。

成败口径与执行 bash 脚本一致：``run()`` 正常结束即成功，抛出异常即失败
（进程退出码 1，DAG 下游自动 skip）。组件没有数据输入输出端口，只固定写
一个 ``exec_status`` 状态端口供 DAG 连控制依赖边；任务要写文件自己管路径。

任何协议违例抛 :class:`ScriptRunnerError`（简洁中文错误）；业务代码自身
抛出的未知异常保留完整 traceback，便于排查。
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import sys
import traceback

from .context import RunContext

__all__ = [
    "main",
    "ScriptRunnerError",
    "ROUTING_KEYS",
    "ARGS_KEY",
    "STATUS_PORT",
]

ROUTING_KEYS = ("script.module", "script.class")
# Node param carrying the task's own arguments. It is a container (not a
# business value itself): parsed by `_parse_args` into the task params, so the
# key never reaches the job class.
ARGS_KEY = "args"
# Fixed status-only output port (mirrors the exec_bash component): carries
# `{"status": "ok" | "error"}` and exists only to wire control-dependency
# edges in the DAG. Node success itself is decided by the process exit code.
STATUS_PORT = "exec_status"


class ScriptRunnerError(Exception):
    """协议/配置类错误：消息可直接展示给节点配置者。"""


def _load_inputs() -> dict:
    path = os.environ.get("AGENT_UI_INPUT_PATH")
    if not path:
        raise ScriptRunnerError(
            "未注入 AGENT_UI_INPUT_PATH：script_runner 只能由 agent-ui 执行器调起"
        )
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError as e:
        raise ScriptRunnerError(f"读取输入文件失败 {path}: {e}") from e
    except ValueError as e:
        raise ScriptRunnerError(f"输入文件不是合法 JSON {path}: {e}") from e
    if not isinstance(data, dict):
        raise ScriptRunnerError("输入 JSON 顶层必须是对象 {参数: 值}")
    return data


def _tokenize_args(text: str) -> list[tuple[str, bool]]:
    """把 args 文本切成 ``(片段, 是否被引号包裹)`` 列表。

    空白分词；单/双引号内的内容原样成组（保留空格、去掉引号字符）。
    刻意不做任何 shell 展开，规则可预测。引号未闭合报配置错误。

    保留「是否被引号包裹」是为了让 ``--opt "--flag-like"`` 能被识别为
    带值参数——普通分词器会丢掉引号信息，把以 ``--`` 开头的值误判成标志。
    """
    tokens: list[tuple[str, bool]] = []
    buf: list[str] = []
    quoted = False
    in_quote = False
    quote_char = ""
    for ch in text:
        if in_quote:
            if ch == quote_char:
                in_quote = False
            else:
                buf.append(ch)
        elif ch in ("'", '"'):
            in_quote = True
            quote_char = ch
            quoted = True
        elif ch.isspace():
            if buf:
                tokens.append(("".join(buf), quoted))
                buf = []
                quoted = False
        else:
            buf.append(ch)
    if in_quote:
        raise ScriptRunnerError("args 无法按命令行规则分词（引号未闭合）")
    if buf:
        tokens.append(("".join(buf), quoted))
    return tokens


def _parse_args(raw) -> dict:
    """解析节点 ``args`` 文本为任务参数字典（argv 风格，刻意不猜值类型）。

    语法：
      - ``--key value`` 与 ``--key=value``：值一律为字符串
      - ``--flag``（后面没有值片段）：布尔 ``True``
      - 带空格或以 ``--`` 开头的值用引号包住：``--msg "hello world"``
      - 同名重复，后者覆盖前者

    不支持位置参数（裸片段）和 ``-x`` 短选项——它们映射不进命名字典，
    遇到即报配置错误，不静默丢弃。
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        # 非 UI 调用方可直接给出结构化参数。
        return raw
    if not isinstance(raw, str):
        raise ScriptRunnerError(
            f"节点参数 args 必须是文本，实际类型 {type(raw).__name__}"
        )
    if not raw.strip():
        return {}
    tokens = _tokenize_args(raw)

    parsed: dict = {}
    i = 0
    while i < len(tokens):
        token, _ = tokens[i]
        if token == "--" or not token.startswith("--"):
            raise ScriptRunnerError(
                f"args 含无法识别的片段 {token!r}：只支持 --键 值、--键=值、--标志，"
                "不支持位置参数和 -x 短选项"
            )
        body = token[2:]
        if not body.strip():
            raise ScriptRunnerError("args 中存在空键名（单独的 --）")
        if "=" in body:
            key, value = body.split("=", 1)
            key = key.strip()
            if not key:
                raise ScriptRunnerError(f"args 参数 {token!r} 的键名为空")
            parsed[key] = value
            i += 1
            continue
        key = body.strip()
        # 下一个片段是值的条件：不以 -- 开头，**或**它被引号显式包裹
        #（引号里写 --xxx 表示「这就是一个值」）。
        if i + 1 < len(tokens):
            nxt, nxt_quoted = tokens[i + 1]
            if not nxt.startswith("--") or nxt_quoted:
                parsed[key] = nxt
                i += 2
                continue
        parsed[key] = True
        i += 1
    return parsed


def _ensure_component_root_on_path() -> None:
    """把业务仓库 checkout 根目录放到 sys.path 最前。

    执行器本来就以该目录为 cwd（``python -m`` 会把 cwd 放进 sys.path），
    这里显式兜底，保证以绝对 import 路径加载业务模块在任何启动方式下都成立。
    """
    root = os.environ.get("AGENT_UI_COMPONENT_ROOT")
    if root and os.path.isdir(root) and root not in sys.path:
        sys.path.insert(0, root)
    importlib.invalidate_caches()


def _resolve_job_class(module_name: str, class_name: str):
    try:
        module = importlib.import_module(module_name)
    except Exception as e:
        raise ScriptRunnerError(
            f"导入业务模块失败 {module_name!r}: {type(e).__name__}: {e}"
        ) from e

    if not hasattr(module, class_name):
        classes = [
            name for name, obj in vars(module).items()
            if inspect.isclass(obj) and obj.__module__ == module.__name__
        ]
        hint = f"，模块内定义的类: {classes}" if classes else "，模块内没有定义任何类"
        raise ScriptRunnerError(f"模块 {module_name!r} 中找不到类 {class_name!r}{hint}")

    cls = getattr(module, class_name)
    if not inspect.isclass(cls):
        raise ScriptRunnerError(
            f"{module_name}.{class_name} 不是类（实际类型 {type(cls).__name__}）"
        )
    return cls


def _make_job_instance(cls):
    """无参实例化任务类。

    任务类不允许定义带参 ``__init__``——没有需要跨方法持有的状态，参数统一
    由 ``run(params)`` 接收。
    """
    try:
        return cls()
    except TypeError as e:
        raise ScriptRunnerError(
            f"任务类 {cls.__name__} 必须能无参实例化：不要定义带参数的 __init__，"
            f"任务参数统一由 run(params) 接收: {e}"
        ) from e
    except Exception as e:
        raise ScriptRunnerError(
            f"任务类 {cls.__name__} 实例化失败: {type(e).__name__}: {e}"
        ) from e


def _bind_run(job, cls):
    """找到 ``run`` 方法并按其形参决定调用方式。

    绑定后的方法已不含 ``self``：
      - 1 个形参 → ``run(params)``
      - 2 个形参 → ``run(params, ctx)``
    其他形态（0 个、3 个、``*args``/``**kwargs``）一律报协议错误。
    """
    run = getattr(job, "run", None)
    if not callable(run):
        raise ScriptRunnerError(f"任务类 {cls.__name__} 没有可调用的 run() 方法")
    try:
        sig = inspect.signature(run)
    except (TypeError, ValueError) as e:
        raise ScriptRunnerError(
            f"无法识别任务类 {cls.__name__}.run 的方法签名: {e}"
        ) from e

    ordinary = [
        p for p in sig.parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    has_var = any(
        p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
        for p in sig.parameters.values()
    )
    if len(ordinary) not in (1, 2) or has_var:
        suffix = "（不支持 *args/**kwargs）" if has_var else ""
        raise ScriptRunnerError(
            f"任务类 {cls.__name__}.run 签名必须是 run(self, params) 或 "
            f"run(self, params, ctx)，实际有 {len(ordinary)} 个位置形参{suffix}"
        )
    return run, len(ordinary) == 2


def _write_status(status: str, error: str = "") -> None:
    """回写固定状态端口。best effort：节点成败只看退出码，写状态文件失败
    （如平台没注入输出路径）绝不能反过来影响判定。"""
    out_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if not out_path:
        return
    payload = {STATUS_PORT: {"status": status}}
    if error:
        payload[STATUS_PORT]["error"] = error
    try:
        parent = os.path.dirname(os.path.abspath(out_path))
        os.makedirs(parent, exist_ok=True)
        tmp = f"{out_path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, out_path)
    except OSError:
        pass


def main() -> int:
    """组件进程入口。返回进程退出码（0 成功 / 1 失败）。"""
    try:
        raw_inputs = _load_inputs()

        module_name = raw_inputs.get("script.module")
        if not isinstance(module_name, str) or not module_name.strip():
            raise ScriptRunnerError(
                "缺少节点参数 script.module（业务模块的 import 路径，如 'jobs.daily_job'）"
            )
        class_name = raw_inputs.get("script.class")
        if not isinstance(class_name, str) or not class_name.strip():
            raise ScriptRunnerError(
                "缺少节点参数 script.class（任务类名，如 SyncIndexConstituents）"
            )

        # 本组件没有数据输入端口：任务参数只来自 args 文本；路由键不下发。
        params = _parse_args(raw_inputs.get(ARGS_KEY))

        _ensure_component_root_on_path()
        cls = _resolve_job_class(module_name.strip(), class_name.strip())
        ctx = RunContext()
        job = _make_job_instance(cls)
        run, with_ctx = _bind_run(job, cls)

        # 返回值刻意忽略：成败只看是否抛异常（与执行脚本看退出码同构）。
        if with_ctx:
            run(params, ctx)
        else:
            run(params)
        _write_status("ok")
        return 0

    except ScriptRunnerError as e:
        # 协议/配置错误：一行明确原因，不需要 traceback 噪音。
        print(f"[script-runner] 配置/协议错误: {e}", file=sys.stderr)
        _write_status("error", str(e))
        return 1
    except Exception as e:
        # 业务代码自身的异常：保留完整 traceback。
        print("[script-runner] 任务执行异常:", file=sys.stderr)
        traceback.print_exc()
        _write_status("error", f"{type(e).__name__}: {e}")
        return 1
