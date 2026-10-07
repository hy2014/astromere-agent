"""任务运行上下文（RunContext）。

业务任务类通过它访问平台注入的运行时能力，不直接读环境变量，便于脱离平台
在普通 Python 环境中单元测试。
"""

from __future__ import annotations

import os
import sys

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

    - :attr:`log` 为节点日志器（debug/info/warning/error，写入节点日志）。
    - :attr:`env` 是组件进程环境变量的快照字典。

    本组件没有数据输出端口，不托管任务文件；任务要写文件时自己决定路径。
    """

    def __init__(self):
        self.log = _StreamLogger()
        self.env = dict(os.environ)
