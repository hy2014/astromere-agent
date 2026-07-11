# 决策：helloworld 按端口名 `Input` 读取输入（纠正"盲扫"错误范式，2026-07-11）

## Why
- 上一版 `components/helloworld/run.py` 用 `find_file_card` **遍历入参所有 value、返回第一个含
  `path` 的 dict** 来定位文件卡片。这是错误范式，用户当场用反例证伪：
  - 若组件有两个输入端口 `InputA`(文件A)、`InputB`(文件B)，盲扫无法区分 A/B，merge 直接报废。
  - 端口名是组件的 **API 契约**：改端口名 = 破坏性接口变更 = 组件代码必须同步改。盲扫回避了
    端口名，等于否认契约，逻辑上站不住脚。
- 正确契约（引擎侧事实）：worker 投递输入时**按端口名 keyed**——`data[port_name]` 即该端口收到的
  文件卡片 / 标量。组件代码必须**按声明的端口名逐个读取每个输入**。

## What
- 重写 `components/helloworld/run.py`：
  - **按端口名读取**：`card = data.get("Input")`，明确引用声明的输入端口名 `Input`。
    只有它是个含非空 `path` 的 dict 时才当文件卡片处理；否则报清晰错误
    （"expects a file card on its 'Input' input port"）。
  - **删除** `find_file_card` 盲扫函数与 `run_scalar_mode` 标量回退（旧的 `text` 回声是混淆契约的
    hack，本仓库 helloworld 是纯文件组件，且 `executor_e2e.rs` 用的是独立内联副本，不受影响）。
  - 文件模式：读 `card["path"]` CSV → 每行追加 `helloworld` 列（值恒为 `"helloworld"`）→
    写出新 CSV → 以输出端口名 `output` 为 key 输出文件卡片
    `{"output": {"path": <新csv>, "format": "csv"}}`。
  - 仅用标准库（`csv` / `tempfile` / `json` / `os`），`requirements.txt` 保持空。
- **不碰 DB**：组件 `components` 表端口 `format` 标签（csv/file）只是展示用，运行时引擎按端口名路由，
  与本次修正无关；先前误改 DB 已被撤回，保持不动。
- 文档同步：
  - `decisions/2026-07-11-helloworld-consume-file.md`：其 What 中"扫描入参中任何文件卡片"表述错误，
    已在本文档纠正，旧文档保留作为演进记录。
  - `docs/engine-executor.md`「文件卡片消费示例」：改为"按端口名 `Input` 读取"，删去扫描说法。
  - `components/helloworld/README.md`：更新为"按 `Input` 端口读取文件卡片"。

## Affected
- `components/helloworld/run.py`（重写：按端口名读取，删盲扫 + 标量回退）
- `components/helloworld/README.md`
- `docs/engine-executor.md`
- `decisions/2026-07-11-helloworld-consume-file.md`（标注被本文档纠正）

## Impact
- `dataset-loader → helloworld` 链路：helloworld 现在明确从 `Input` 端口取文件卡片、读 CSV、加列、
  以 `output` 端口回传新文件卡片。端口语义清晰，多输入组件也可照此范式逐个按端口名读取。
- 引擎侧无需改动：worker 已按端口名 keyed 投递、handle 前缀已 strip，这是纯组件行为修正。
- 不改 DB、不破 `executor_e2e.rs`（其内联 helloworld 副本独立）。
- 组件代码由引擎 `git pull dev` 拉取，改完需 `push` 到 `dev` 才对正在运行的引擎生效。
