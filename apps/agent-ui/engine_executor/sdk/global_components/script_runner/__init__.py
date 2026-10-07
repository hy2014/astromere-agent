"""script_runner —— 通用脚本内置组件。

把业务仓库中任意模块里的一个**任务类**作为 DAG 节点执行，业务侧不需要编写
任何组件样板代码（entry 文件、状态回写都由本组件统一处理）。

组件形态与「执行 bash 脚本」一致：没有数据输入输出端口，只有一个固定的
``exec_status`` 状态端口用于在 DAG 里连「成功后再跑」的控制依赖边；任务
成败只看 ``run()`` 是否抛出异常（对应进程退出码）。任务要写文件自己管路径。

业务协议
--------

模块中定义一个可被 ``(params, ctx)`` 两个位置参数构造的类，默认类名 ``Job``
（可通过节点参数 ``script.class`` 覆盖），并实现无参 ``run()`` 方法::

    from global_components.script_runner import ScriptJob

    class Job(ScriptJob):
        def run(self):
            value = self.params["some_param"]
            self.log.info("running")

节点参数（组件定义里固定这三个，不含任何业务字段）：

    script.module   必填  业务模块的 import 路径，如 "jobs.daily_job"
    script.class    选填  任务类名，默认 "Job"
    args            选填  命令行风格的任务参数文本，如
                          '--date 2026-01-01 --mode=full --dry-run'

args 语法：``--键 值`` / ``--键=值``（值为字符串），``--标志``（布尔
``True``），带空格的值用引号包裹；不支持位置参数和 ``-x`` 短选项。args
解析后即任务类拿到的 params（args 这个键本身不下发）。

``run()`` 不需要返回值；正常结束节点即成功，抛出异常即失败（退出码 1，
下游自动 skip）。
"""

from .base import ScriptJob
from .context import RunContext

__all__ = ["ScriptJob", "RunContext"]
