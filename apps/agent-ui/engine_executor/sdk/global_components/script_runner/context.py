"""任务运行上下文（RunContext）。

业务任务类通过它访问平台注入的运行时能力，不直接读环境变量，便于脱离平台
在普通 Python 环境中单元测试。
"""

from __future__ import annotations

import os
import sys

import component_sdk

__all__ = ["RunContext"]


class _StreamLogger:
    """最小日志器：写入 stderr（worker 会原样收集进节点日志）。

    刻意不依赖 logging 配置——内置组件在任意业务解释器里都应零配置可用。
    """

    def __init__(self, prefix: str = "script-runner"):
        self._prefix = prefix

    def _emit(self, level: str, message: object) -> None:
        print(f"[{self._prefix}] {level}: {message}", file=sys.stderr, flush=True)

    def debug(self, message: object) -> None:
        self._emit("debug", message)

    def info(self, message: object) -> None:
        self._emit("info", message)

    def warning(self, message: object) -> None:
        self._emit("warning", message)

    warn = warning

    def error(self, message: object) -> None:
        self._emit("error", message)


class RunContext:
    """传给业务任务类构造函数的运行时上下文。

    - :meth:`output_dir` 取平台为输出端口分配的目录（未注入时回退到
      ``fallback_root/端口名``，保证本地脱离平台调试也能写出文件）。
    - :attr:`log` 为节点日志器。
    - :attr:`env` 是组件进程环境变量的只读视图。
    """

    def __init__(self, fallback_root: str | None = None):
        self.log = _StreamLogger()
        self.env = dict(os.environ)
        self._fallback_root = fallback_root or os.path.join(
            os.getcwd(), ".script_runner_outputs"
        )

    def output_dir(self, port: str) -> str:
        """返回端口 ``port`` 被平台分配的输出目录；脱离平台运行时回退到
        ``fallback_root/<port>``。目录会被按需创建。"""
        if not isinstance(port, str) or not port:
            raise ValueError("output_dir 需要非空字符串端口名")

        # 平台契约的解析（AGENT_UI_OUTPUT_DATA_DIRS）统一走 component_sdk，
        # 保持单一真相源；仅在脱离平台单跑时用 fallback 目录补齐。
        target = component_sdk.resolve_output_dir(port)
        if not target:
            target = os.path.join(self._fallback_root, port)

        os.makedirs(target, exist_ok=True)
        return target
