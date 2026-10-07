# 通用脚本组件（script_runner）

平台内置的通用组件：业务仓库里只要有一个「任务类」，就能作为 DAG 节点运行，
不需要为每个任务写组件样板。

形态和「执行 bash 脚本」组件完全一致：**没有数据输入输出，只有一个状态端口**。
任务不抛异常就是成功，抛异常就是失败；DAG 里用状态端口连「成功后再跑」的
控制依赖边。任务要写文件、写库，路径和连接都由任务自己管理。

执行器本身随平台分发（PYTHONPATH 注入），业务仓库不需要安装它；业务仓库照常
被 checkout、照常安装 `requirements.txt` 里的依赖。区别只在执行入口不填文件
路径，而填一个平台保留关键字 `@global_components.script_runner`。

## 使用方式：内联组件

script_runner 面向多个业务仓库，git 地址每个仓库不同、不能复用，因此直接用
**内联组件**承载，不需要走注册流程：

1. 从组件面板拖一个「内联组件」到画布；
2. 在节点的组件定义区填：

| 项 | 填法 |
| --- | --- |
| Git 地址 / 分支 | 业务仓库的地址和分支（测试阶段可填本机绝对路径） |
| 执行入口 | 固定填 `@global_components.script_runner` |
| 输入端口 | 不加 |
| 输出端口 | 加一个，端口名 `exec_status`，类型「状态」 |

3. 在节点参数区（自由键值表）加三个键：

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `script.module` | 是 | 任务类所在模块的 import 路径，如 `jobs.daily_job` |
| `script.class` | 是 | 任务类名，如 `BuildReport`；同一模块多个类靠它区分 |
| `args` | 否 | 传给任务的参数，命令行风格，语法见下一节 |

同一个业务仓库要在多个节点/多个 DAG 里反复用时，也可以在「注册组件」里登记
一次（configSchema 声明上面三个键，inputSchema 留空，outputSchema 固定
`exec_status` 状态端口），之后拖出的节点直接填 module/class/args；两种承载
方式运行时完全等价。

`@` 开头的入口不做仓库文件检查（点「验证配置」直接通过）；运行时由 worker
解析关键字。关键字拼错会明确报错，并列出当前可用的内置入口。

## args 语法

参数写在节点的 `args` 里，规则刻意保持命令行语义：

- `--键 值` 和 `--键=值` 等价：`--date 2026-01-01`、`--date=2026-01-01`
- 只有键、后面不带值的是布尔标志，任务里拿到 `True`：`--dry-run`
- 值带空格用单/双引号包住：`--msg "hello world"`
- 值本身以 `--` 开头时用引号或等号形式：`--opt "--literal"`、`--opt=--literal`
- 同一个键写多次，后面的值覆盖前面的
- 可以换行写，每行若干参数

值**一律是字符串**，不做数字/布尔的自动猜测（避免日期、版本号、前导零被误转）；
任务里需要数字就自己 `int(params["limit"])`。

不支持位置参数（裸写 `abc`）和 `-x` 短选项；引号没闭合等写法会在节点日志里
直接报中文错误，不会静默忽略。

## 业务侧协议：一个无构造参数的类 + run 方法

模块里定义一个普通类，满足三条：

1. **不写带参数的 `__init__`**（类无状态，平台用无参方式实例化；参数由 `run`
   接收）；
2. 类名由节点参数 `script.class` 显式指定，没有默认类名；
3. 有一个 `run` 方法，**形参决定平台怎么调用它**：

```python
class BuildReport:
    def run(self, params):
        ...

class LoggingTask:
    def run(self, params, ctx):
        ...
```

- `run(self, params)`：平台只传参数。
- `run(self, params, ctx)`：平台额外传运行时上下文。
- 其他形态（没有 params、参数超过两个、`*args`/`**kwargs`）节点启动时报协议
  错误。

任务类不需要继承任何平台基类，也不需要 import 平台代码。

### params：任务参数（dict）

节点 `args` 解析出的命名字典。args 填 `--date 2026-01-01 --dry-run`，
任务里就是 `params["date"] == "2026-01-01"`、`params["dry-run"] is True`。

- 组件没有数据输入端口，params 里只有 args 展开的内容；`script.module` /
  `script.class` / `args` 这三个键本身不会出现。
- 没有连上游数据边的能力；需要上游产物的任务不适合用本组件，应使用文件型组件。

### ctx：运行时上下文（按需声明）

- `ctx.log`：节点日志器，方法 `debug / info / warning / error`，输出进节点日志。
- `ctx.env`：进程环境变量的快照字典。

### 成败只看异常

- `run` 正常跑完（返回值会被忽略）→ 节点成功，平台自动写 `exec_status = ok`。
- 抛出任何异常 → 节点失败（退出码 1，完整 traceback 进节点日志，平台写
  `exec_status = error`），DAG 下游自动跳过。

任务要写文件：自己决定路径（可以直接写死，也可以作为 args 参数传入），
自己建目录；平台不托管任务文件。需要共享连接（如数据库）时，任务里直接
`import component_sdk` 用平台 SDK 读取共享登记。

## 最小示例

业务仓库 `jobs/daily_job.py`：

```python
import csv
import os


class BuildReport:
    def run(self, params):
        date = params["date"]
        outfile = params["outfile"]
        os.makedirs(os.path.dirname(outfile), exist_ok=True)
        with open(outfile, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["date"])
            writer.writerow([date])
```

需要打日志时把签名改成 `run(self, params, ctx)`，用 `ctx.log.info(...)`。

节点参数：`script.module = jobs.daily_job`，`script.class = BuildReport`，
`args` 填：

```
--date 2026-01-01
--outfile /data/reports/2026-01-01.csv
```

仓里以后再加任务类，不用改任何组件配置，新节点填对应的 `script.module` /
`script.class` 即可；同一个模块里放多个类时，只改 `script.class` 就能切换。

## 脱离平台本地调试

任务不 import 平台代码，可以直接实例化调用：

```python
from jobs.daily_job import BuildReport

# 直接给参数字典，等价于节点 args 填 --date 2026-01-01
BuildReport().run({"date": "2026-01-01", "outfile": "/tmp/report.csv"})
```

`run` 声明了 ctx 时，本地可传一个最小替身：`BuildReport().run(params, ctx)`，
ctx 只需提供任务实际用到的属性（通常是带 `info/error` 方法的 `log`）。

## 错误口径

- 配置/协议错误（没填 `script.module` / `script.class`、args 语法不对、模块
  导不进来、类不存在、类定义了带参 `__init__`、没有 `run()`、`run` 签名不
  合法等）：节点日志给出一行中文原因，退出码 1。
- 业务 `run()` 自身抛出的异常：保留完整 traceback，退出码 1。

## 边界

- 平台只执行 `@` 关键字注册表里的入口，当前内置入口只有
  `@global_components.script_runner` 一个。
- 本组件只做「执行 + 成败上报」：没有输入端口、没有文件输出端口，任务之间
  不能通过它传递数据产物；需要数据管道时使用文件型组件。
- args 只承载标量命名参数（字符串/布尔标志）；需要数组、嵌套结构或大量参数时，
  让任务读自己的配置文件，不要把复杂结构塞进 args。
- 依赖安装没有特殊通道：业务仓库照常维护 `requirements.txt`。
