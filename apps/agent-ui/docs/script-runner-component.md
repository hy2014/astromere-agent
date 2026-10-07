# 通用脚本组件（script_runner）

平台内置的通用组件：业务仓库里只要有一个「任务类」，就能作为 DAG 节点运行，
不需要为每个任务写组件样板。

形态和「执行 bash 脚本」组件完全一致：**没有数据输入输出，只有一个状态端口**。
任务不抛异常就是成功，抛异常就是失败；DAG 里用状态端口连「成功后再跑」的
控制依赖边。任务要写文件、写库，路径和连接都由任务自己管理。

业务仓库仍然按普通组件一样登记 git 地址和分支，平台照常 checkout、照常安装
`requirements.txt` 里的依赖；区别只在入口不填文件路径，而填一个平台保留
关键字。

## 注册

| 项 | 填法 |
| --- | --- |
| entryPoint | 固定填 `@global_components.script_runner`（保留关键字，不是仓库内文件） |
| gitUrl / gitBranch | 业务仓库的地址和分支，与普通组件完全一致 |
| configSchema | 固定声明下面三个字段，不含任何业务字段——一个仓库只需注册一次，仓里所有任务类共用这个组件 |
| inputSchema | 留空（无输入端口，不接数据边） |
| outputSchema | 固定一个输出端口 `exec_status`，类型 `status` |

configSchema 的三个字段：

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `script.module` | string | 是 | 任务类所在模块的 import 路径，如 `jobs.daily_job` |
| `script.class` | string | 否 | 任务类名，不填时默认 `Job` |
| `args` | textarea | 否 | 传给任务的参数，命令行风格，语法见下一节 |

`@` 开头的入口不做仓库文件检查（点「验证配置」直接通过）；运行时由 worker
解析关键字。关键字拼错会明确报错，并列出当前可用的内置入口。

## args 语法

参数写在节点的 `args` 文本框里，规则刻意保持命令行语义：

- `--键 值` 和 `--键=值` 等价：`--date 2026-01-01`、`--date=2026-01-01`
- 只有键、后面不带值的是布尔标志，任务里拿到 `True`：`--dry-run`
- 值带空格用单/双引号包住：`--msg "hello world"`
- 值本身以 `--` 开头时用引号或等号形式：`--opt "--literal"`、`--opt=--literal`
- 同一个键写多次，后面的值覆盖前面的
- 可以换行写，每行若干参数

值**一律是字符串**，不做数字/布尔的自动猜测（避免日期、版本号、前导零被误转）；
任务里需要数字就自己 `int(self.params["limit"])`。

不支持位置参数（裸写 `abc`）和 `-x` 短选项；引号没闭合等写法会在节点日志里
直接报中文错误，不会静默忽略。

## 业务侧协议（类，不是函数）

模块里定义一个类，满足两条：

1. 能用 `(params, ctx)` 两个位置参数构造；
2. 有一个无参的 `run()` 方法。

### params：任务参数（dict）

节点 `args` 解析出的命名字典。args 填 `--date 2026-01-01 --dry-run`，
任务里就是 `params["date"] == "2026-01-01"`、`params["dry-run"] is True`。

- 组件没有数据输入端口，params 里只有 args 展开的内容；`script.module` /
  `script.class` / `args` 这三个键本身不会出现
- 没有连上游数据边的能力；需要上游产物的任务不适合用本组件，应使用文件型组件

### ctx：运行时上下文（RunContext）

- `ctx.log`：节点日志器，方法 `debug / info / warning / error`，输出进节点日志。
- `ctx.env`：进程环境变量的快照字典。

### run()：无返回值，异常表成败

- 正常跑完（不返回或返回 `None`，返回其他值也会被忽略）→ 节点成功，平台自动
  写 `exec_status = ok`。
- 抛出任何异常 → 节点失败（退出码 1，完整 traceback 进节点日志，平台写
  `exec_status = error`），DAG 下游自动跳过。

任务要写文件：自己决定路径（可以直接写死，也可以作为 args 参数传入），
自己建目录；平台不托管任务文件。需要共享连接（如数据库）时，任务里直接
`import component_sdk` 用平台 SDK 读取共享登记。

### 可选基类 ScriptJob

继承它可以省去构造函数，并拿到 `self.params`、`self.ctx`、`self.log`：

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
        date = self.params["date"]
        outfile = self.params["outfile"]
        os.makedirs(os.path.dirname(outfile), exist_ok=True)
        with open(outfile, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date"])
            writer.writerow([date])
        self.log.info(f"report written: {outfile}")
```

节点上：`script.module` 填 `jobs.daily_job`，`script.class` 留空（默认 `Job`），
`args` 填：

```
--date 2026-01-01
--outfile /data/reports/2026-01-01.csv
```

仓里以后再加任务类（如 `jobs.weekly_job.Job`），不用改组件定义，新节点把
`script.module` 换成对应模块即可。

## 脱离平台本地调试

```python
from global_components.script_runner import RunContext
from jobs.daily_job import Job

# 直接给参数字典，等价于节点 args 填 --date 2026-01-01
Job({"date": "2026-01-01", "outfile": "/tmp/report.csv"}, RunContext()).run()
```

## 错误口径

- 配置/协议错误（没填 `script.module`、args 语法不对、模块导不进来、类不存在、
  构造函数签名不对、没有 `run()` 等）：节点日志给出一行中文原因，退出码 1。
- 业务 `run()` 自身抛出的异常：保留完整 traceback，退出码 1。

## 边界

- 平台只执行 `@` 关键字注册表里的入口，当前内置入口只有
  `@global_components.script_runner` 一个。
- 本组件只做「执行 + 成败上报」：没有输入端口、没有文件输出端口，任务之间
  不能通过它传递数据产物；需要数据管道时使用文件型组件。
- args 只承载标量命名参数（字符串/布尔标志）；需要数组、嵌套结构或大量参数时，
  让任务读自己的配置文件，不要把复杂结构塞进 args。
- 依赖安装没有特殊通道：业务仓库照常维护 `requirements.txt`。
