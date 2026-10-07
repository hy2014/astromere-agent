"""script_runner 核心执行逻辑。

流程：读平台注入的 input.json → 按 ``script.module`` / ``script.class``
定位业务任务类 → 用 ``(inputs, ctx)`` 实例化并调用其无参 ``run()`` →
把返回的端口字典原子写入 output.json。

任何协议违例抛 :class:`ScriptRunnerError`（简洁中文错误）；业务代码自身
抛出的未知异常保留完整 traceback，便于排查。
"""

from __future__ import annotations

import importlib
import inspect
import json
import math
import os
import sys
import traceback

from .context import RunContext

__all__ = ["main", "ScriptRunnerError", "DEFAULT_CLASS_NAME", "ROUTING_KEYS"]

DEFAULT_CLASS_NAME = "Job"
ROUTING_KEYS = ("script.module", "script.class")


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
        raise ScriptRunnerError("输入 JSON 顶层必须是对象 {参数/端口: 值}")
    return data


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


def _instantiate_job(cls, inputs: dict, ctx: RunContext):
    try:
        job = cls(inputs, ctx)
    except TypeError as e:
        raise ScriptRunnerError(
            f"任务类 {cls.__name__} 必须能用 (inputs, ctx) 两个位置参数构造: {e}"
        ) from e
    except Exception as e:
        raise ScriptRunnerError(
            f"任务类 {cls.__name__} 构造失败: {type(e).__name__}: {e}"
        ) from e

    run = getattr(job, "run", None)
    if not callable(run):
        raise ScriptRunnerError(f"任务类 {cls.__name__} 没有可调用的 run() 方法")
    return job


def _to_jsonable(value, path: str = "$"):
    """把 run() 返回值规整为严格可 JSON 序列化的对象。

    - 路径类型（pathlib）→ str（端口值的常规形态）
    - dict 键统一为 str；list/tuple → list
    - 拒绝 NaN/Infinity（合法 JSON 不允许）与其他不支持的类型，报错带定位路径
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ScriptRunnerError(f"输出在 {path} 处为 NaN/Infinity，不能序列化为 JSON")
        return value
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    if isinstance(value, dict):
        return {
            str(key): _to_jsonable(item, f"{path}.{key}")
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(item, f"{path}[{i}]") for i, item in enumerate(value)]
    raise ScriptRunnerError(
        f"输出在 {path} 处含不可 JSON 序列化的类型 {type(value).__name__}，"
        f"请先转换为基础类型/str 路径/dict/list"
    )


def _write_output(payload: dict) -> None:
    out_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if not out_path:
        raise ScriptRunnerError("未注入 AGENT_UI_OUTPUT_PATH，无法回写输出")
    parent = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(parent, exist_ok=True)
    tmp = f"{out_path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)


def main() -> int:
    """组件进程入口。返回进程退出码（0 成功 / 1 失败）。"""
    try:
        raw_inputs = _load_inputs()

        module_name = raw_inputs.get("script.module")
        if not isinstance(module_name, str) or not module_name.strip():
            raise ScriptRunnerError(
                "缺少节点参数 script.module（业务模块的 import 路径，如 'jobs.daily_job'）"
            )
        class_name = raw_inputs.get("script.class", DEFAULT_CLASS_NAME)
        if not isinstance(class_name, str) or not class_name.strip():
            raise ScriptRunnerError("节点参数 script.class 必须是非空字符串")

        # 平台路由参数不下发给业务任务；其余 params 与上游产物平铺为业务输入。
        inputs = {k: v for k, v in raw_inputs.items() if k not in ROUTING_KEYS}

        _ensure_component_root_on_path()
        cls = _resolve_job_class(module_name.strip(), class_name.strip())
        ctx = RunContext()
        job = _instantiate_job(cls, inputs, ctx)

        result = job.run()
        if result is None:
            result = {}
        if not isinstance(result, dict):
            raise ScriptRunnerError(
                f"run() 必须返回 dict（{{端口名: 端口值}}）或 None，"
                f"实际返回 {type(result).__name__}"
            )
        for key in result:
            if not isinstance(key, str) or not key:
                raise ScriptRunnerError("输出字典的键必须是非空字符串端口名")

        _write_output(_to_jsonable(result))
        return 0

    except ScriptRunnerError as e:
        # 协议/配置错误：一行明确原因，不需要 traceback 噪音。
        print(f"[script-runner] 配置/协议错误: {e}", file=sys.stderr)
        return 1
    except Exception:
        # 业务代码自身的异常：保留完整 traceback。
        print("[script-runner] 任务执行异常:", file=sys.stderr)
        traceback.print_exc()
        return 1
