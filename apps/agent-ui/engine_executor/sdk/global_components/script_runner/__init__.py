"""script_runner —— 通用脚本内置组件。

把业务仓库中任意模块里的一个**任务类**作为 DAG 节点执行，业务侧不需要编写
任何组件样板代码（entry 文件、I/O 契约、输出回写都由本组件统一处理）。

业务协议
--------

模块中定义一个可被 ``(inputs, ctx)`` 两个位置参数构造的类，默认类名 ``Job``
（可通过节点参数 ``script.class`` 覆盖），并实现无参 ``run()`` 方法::

    from global_components.script_runner import ScriptJob

    class Job(ScriptJob):
        def run(self):
            value = self.inputs["some_param"]
            out_dir = self.output_dir("result")
            self.log.info("running")
            return {"result": f"{out_dir}/data.json"}

节点参数（与上游产物合并后平铺进 inputs）：

    script.module   必填  业务模块的 import 路径，如 "jobs.daily_job"
    script.class    选填  任务类名，默认 "Job"

``run()`` 的返回值必须是 ``{输出端口名: 端口值}`` 字典（或不返回，视为无
输出）；抛出异常即节点失败。
"""

from .base import ScriptJob
from .context import RunContext

__all__ = ["ScriptJob", "RunContext"]
