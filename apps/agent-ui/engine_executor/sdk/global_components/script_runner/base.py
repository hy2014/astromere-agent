"""业务任务类的可选基类 ScriptJob。

继承它只省去写 ``__init__``；平台只认鸭子类型契约——任何能被
``(params, ctx)`` 构造、且有无参 ``run()`` 方法的类都合法，因此业务侧
不继承本基类也可以（便于在没有平台 PYTHONPATH 的环境里零依赖调试）。
"""

from __future__ import annotations

__all__ = ["ScriptJob"]


class ScriptJob:
    """任务基类。

    Attributes:
        params: 节点 ``args`` 解析出的任务参数（argv 风格的命名字典，
            值为字符串或布尔标志）。
        ctx: 运行时上下文，见 :class:`RunContext`。
    """

    def __init__(self, params, ctx):
        self.params = params
        self.ctx = ctx

    @property
    def log(self):
        """便捷转发：节点日志器。"""
        return self.ctx.log

    def run(self):
        """业务入口，子类必须实现。无返回值；抛异常即节点失败。"""
        raise NotImplementedError(
            f"{type(self).__name__} 必须实现 run() 方法"
        )
