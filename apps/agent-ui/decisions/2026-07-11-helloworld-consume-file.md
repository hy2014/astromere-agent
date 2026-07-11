# 决策：helloworld 改为真正"读文件 → 加列 → 输出"的组件（2026-07-11）

> ⚠️ 本文档「What」中"扫描入参中任何文件卡片"的表述**已被纠正**：组件必须按声明的端口名
> 读取输入，不能盲扫所有 value 找 `path`（多输入组件会丢失端口归属）。正确实现见
> `decisions/2026-07-11-helloworld-read-by-port-name.md`。

## Why
- 用户指出 helloworld 当前只做**字符串回声**：`data.get("text")` + 字符串拼接，并不消费上游
  dataset-loader 产出的 `outputFile` 文件卡片 `{"path":..., "format":"csv"}`。
- 在 `dataset-loader → helloworld` 链路里，helloworld 通过边收到的 `Input` 是一张"文件卡片"
  而非字符串。原实现把它当字符串拼进输出，CSV 从头到尾没被打开 → 链路名不符实。
- 用户期望的行为：helloworld **读取输入文件**、**新增一列 `helloworld`（内容全为 `helloworld`）**、
  **输出出去**（产出一份带新列的文件，供下游继续消费）。

## What
- 重写 `components/helloworld/run.py`：
  - **文件模式（主路径）**：扫描入参中任何 `{"path":...}` 形式的文件卡片 → `open(path)` 读取
    CSV → 为每一行新增 `helloworld` 列（值恒为字符串 `"helloworld"`）→ 写出新 CSV 文件 →
    以输出端口名 `output` 为 key 输出文件卡片 `{"output": {"path": <新csv>, "format": "csv"}}`。
  - **标量回退（兼容独立运行 / 旧用法）**：若入参中没有任何文件卡片、但存在 `text` 标量，则
    退回原回声行为（`{"text":..., "helloworld": f"{text}-helloworld"}`），保证
    `executor_e2e.rs`（其内联 helloworld 副本）等旧用法不破。
  - 仅用标准库（`csv` / `tempfile` / `json` / `os`），`requirements.txt` 保持空。
- 对齐组件契约（本地 DB `components` 表 helloworld 行）：`Input` 端口 `format` 改 `file`、
  `output` 端口 `format` 改 `file`，与 dataset-loader 的 `outputFile`(format=file) 端口语义一致，
  避免"文件卡片 ↔ csv 标量"的端口类型错位。
- 文档同步：
  - `docs/engine-executor.md`：新增「文件卡片消费示例（helloworld）」小节，说明下游如何吃
    上游的 `format=file` 卡片。
  - `components/helloworld/README.md`：更新为"读输入文件、加 `helloworld` 列、输出文件卡片"。

## Affected
- `components/helloworld/run.py`（重写）
- `components/helloworld/README.md`
- 本地 DB `components` 表 helloworld 行 `input_schema` / `output_schema`（format → file）
- `docs/engine-executor.md`

## Impact
- `dataset-loader → helloworld` 链路现在真正读文件、加列、产出新文件卡片；下游可继续接文件消费节点。
- 引擎侧无需改动：worker 已正确把文件卡片透传（handle 前缀修复已生效），这是纯组件行为修正。
- 旧 `src-tauri/tests/executor_e2e.rs` 不受影响（其内联 helloworld 仍是标量回声副本）。
- 组件代码由引擎 `git pull dev` 拉取，改完需 `push` 到 `dev` 才对正在运行的引擎生效。
