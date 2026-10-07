"""业务任务类的可选基类 ScriptJob。

继承它只省去写 ``__init__``；平台只认鸭子类型契约——任何能被
``(inputs, ctx)`` 构造、且有无参 ``run()`` 方法的类都合法，因此业务侧
不继承本基类也可以（便于在没有平台 PYTHONPATH 的环境里零依赖调试）。
"""

from __future__ import annotations

__all__ = ["ScriptJob"]


class ScriptJob:
    """任务基类。

    Attributes:
        inputs: 节点参数与上游产物合并后的完整输入（平台路由用的
            ``script.module`` / ``script.class`` 已被剔除）。
        ctx: 运行时上下文，见 :class:`RunContext`。
    """

    def __init__(self, inputs, ctx):
        self.inputs = inputs
        self.ctx = ctx

    def output_dir(self, port: str) -> str:
        """便捷转发：取平台为输出端口分配的目录。"""
        return self.ctx.output_dir(port)

    @property
    def log(self):
        """便捷转发：节点日志器。"""
        return self.ctx.log

    def run(self):
        """业务入口，子类必须实现。返回 ``{端口名: 端口值}`` 或 None。"""
        raise NotImplementedError(
            f"{type(self).__name__} 必须实现 run() 方法"
        )
