# 通用脚本组件（script_runner）

平台内置的通用组件：业务仓库里只要有一个「任务类」，就能作为 DAG 节点运行，
不需要为每个任务写组件样板（入口文件、读写输入输出 JSON 等都由本组件统一处理）。

业务仓库仍然按普通组件一样登记 git 地址和分支，平台照常 checkout、照常安装
`requirements.txt` 里的依赖；区别只在入口不用填文件路径，而是填一个平台保留
关键字。

## 注册

| 项 | 填法 |
| --- | --- |
| entryPoint | 固定填 `@global_components.script_runner`（保留关键字，不是仓库内文件） |
| gitUrl / gitBranch | 业务仓库的地址和分支，与普通组件完全一致 |
| configSchema | 声明 `script.module`、`script.class` 两个路由字段，再加上业务自己的参数字段 |
| inputSchema / outputSchema | 照常声明输入输出端口 |

- `script.module`：string，必填。任务类所在模块的 import 路径，如 `jobs.daily_job`。
- `script.class`：string，选填。任务类名，不填时默认 `Job`。
- `@` 开头的入口不做仓库文件检查（点「验证配置」直接通过）；运行时由 worker
  解析关键字。关键字拼错会明确报错，并列出当前可用的内置入口。

## 业务侧协议（类，不是函数）

模块里定义一个类，满足两条：

1. 能用 `(inputs, ctx)` 两个位置参数构造；
2. 有一个无参的 `run()` 方法。

### inputs：节点输入（dict）

节点参数与上游产物平铺合并后的完整字典，例如节点参数 `date`、上游端口
`report`，就在 `inputs["date"]`、`inputs["report"]` 取。`script.module` /
`script.class` 是平台路由用的，不会出现在 inputs 里。`system.` / `dw.` 开头的
平台配置项也不下发。

### ctx：运行时上下文（RunContext）

- `ctx.log`：节点日志器，方法 `debug / info / warning / error`，输出进节点日志。
- `ctx.output_dir(port)`：返回该输出端口被平台分配好的目录（已创建），任务只
  负责往里写文件。脱离平台在本地单跑时，回退到当前目录下的
  `.script_runner_outputs/<port>`。
- `ctx.env`：进程环境变量的快照字典。

### run() 的返回值

- 不返回（或返回 `None`）：视为无输出。
- 返回 `{输出端口名: 端口值}` 字典：端口名必须是非空字符串。
- 端口值形态与平台端口值契约一致：裸路径字符串、`{"path": ..., "format": ...}`
  文件卡片、或二者组成的列表。
- 值必须能被 JSON 序列化；`pathlib.Path` 会自动转成字符串，dict/list/基础类型
  都可以；`NaN`/`Infinity` 及不能序列化的类型直接判失败。

### 可选基类 ScriptJob

继承它可以省去构造函数，并拿到 `self.inputs`、`self.ctx`、`self.log` 和
`self.output_dir(port)` 便捷转发：

```python
from global_components.script_runner import ScriptJob


class Job(ScriptJob):
    def run(self):
        ...
```

不继承也合法——平台只认上面两条鸭子类型契约。不继承时任务类不 import 任何
平台代码，方便脱离平台调试。

## 最小示例

业务仓库 `jobs/daily_job.py`：

```python
import csv
import os

from global_components.script_runner import ScriptJob


class Job(ScriptJob):
    def run(self):
        date = self.inputs["date"]
        out_dir = self.output_dir("report")
        path = os.path.join(out_dir, "report.csv")
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date"])
            writer.writerow([date])
        self.log.info(f"report written: {path}")
        return {"report": {"path": path, "format": "csv"}}
```

节点参数：`script.module = jobs.daily_job`，`script.class` 留空（默认 `Job`），
另配一个业务参数 `date`；输出端口声明 `report`（file）。

## 脱离平台本地调试

```python
from global_components.script_runner import RunContext
from jobs.daily_job import Job

Job({"date": "2026-01-01"}, RunContext()).run()
```

此时没有平台分配的端口目录，`output_dir("report")` 回退到当前目录的
`.script_runner_outputs/report/`。

任务里也可以直接 `import component_sdk`，与普通组件一样使用平台 SDK（如
`resolve_db_connection` 读取共享数据库连接登记）。

## 错误口径

- 配置/协议错误（没填 `script.module`、模块导不进来、类不存在、构造函数签名
  不对、没有 `run()`、返回值不合规等）：节点日志给出一行中文原因，进程以退出
  码 1 结束。
- 业务 `run()` 自身抛出的异常：保留完整 traceback，退出码 1。

## 边界

- 平台只执行 `@` 关键字注册表里的入口，不会借这个通道执行仓库里的任意命令；
  当前内置入口只有 `@global_components.script_runner` 一个。
- 依赖安装没有特殊通道：业务仓库照常维护 `requirements.txt`。
- 平台实例级配置（如数据库连接）不通过构造参数泄漏给任务类，任务类一律经
  `component_sdk` 读取共享登记。
