# Astromere Agent

[English README](README.md)

Astromere Agent 是一个实验性的 agent runtime 和 desktop UI，目标是通过**对话方式实现 Jupyter-like 的探索式工作流**。

它的目标不是让用户写更多代码，而是降低探索成本、提高探索效率：用户不需要手写 Python cell，只需要用自然语言描述需求，引用已有上下文或 artifact，然后让 agent 调用可复用的 skill，生成 rich-display 风格的交互式输出。

一句话概括：

```text
skill + artifact/input reference + text 参数/需求
=> 探索结果
```

本项目目前基于 Claude Code fork，增加了 DeepSeek 适配、桌面端 UI、skill 执行和 session-scoped artifact 能力。

> 本项目 fork 自 `T-Lab-CUHKSZ/claude-code`。本项目不隶属于 Anthropic，也不由 Anthropic 维护或背书。

---

## 为什么是 Jupyter-like？

传统 Jupyter 的强大之处在于它把这些东西组合在一起：

- cell
- Python code
- 可复用变量
- 迭代式探索
- dataframe、chart、Plotly HTML、图片、报告等 rich display

但传统 notebook 仍然要求用户写代码、维护代码、管理变量和中间状态。

Astromere Agent 想探索另一种交互方式：

```text
对话 = runtime cell
skill = 可复用的数据处理 / 分析函数
artifact = 可复用的运行时输出
rich display = notebook output layer
```

用户不需要关心底层 Python 代码怎么写，只需要表达需求：

```text
/kline-chart @samples/kline_sample.csv 生成交互式图表
```

系统负责执行 skill，生成可预览、可引用、可复用的 artifact。

---

## 核心设计

### 1. 每次对话都是一个 runtime cell

用户的一次输入可以看作一个 runtime cell。

这个 cell 可以包含：

- 自然语言需求
- slash-command skill 调用
- 通过 `@file` 引用本地文件
- 引用之前生成的 artifact

runtime cell 可以调用工具、执行 skill，并生成输出。

### 2. Runtime cell 输出 rich-display artifact

cell 的输出不应该只是一段文本。

它可以是：

- 交互式 HTML
- dataframe / table
- image
- JSON
- report
- chart
- 给后续 cell 使用的中间文件

Desktop UI 可以把生成的 artifact 展示成 output link，并在右侧 preview 面板中渲染 HTML 等 rich display。

### 3. Artifact 可以成为后续上下文

生成的 artifact 会存储在 session-scoped 目录中：

```text
<workspace>/.agent-ui/<session-id>/
```

后续对话可以继续引用这些 artifact，从而实现持续探索，而不是每次重新开始。

概念上是：

```text
turn A 生成 cleaned data
turn B 引用 cleaned data 生成 chart
turn C 引用 data/chart 生成 report
```

### 4. Skill 是通用 Python 处理和分析函数

skill 应该像一个高层分析函数，而不是一段暴露给用户的脚本。

模型看到的调用应该保持简单：

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill kline-chart \
  --method kline \
  --input "/absolute/path/to/input.csv"
```

wrapper 负责找到具体实现、执行脚本、记录 artifact，并输出结构化 metadata。

### 5. 用户通过对话探索，而不是写代码

目标工作流是：

```text
用户需求 + 引用的数据 / artifact
=> agent 选择或执行 skill
=> skill 生成 rich artifact
=> 用户预览结果
=> 用户继续追问或引用结果
```

用户不需要手写 Python，不需要 import 库，不需要管理变量，也不需要记住底层文件路径。

---

## 当前能力

### Desktop Agent UI

`apps/agent-ui` 下的桌面端 UI 目前提供：

- 多 session 项目侧边栏
- stream-json REPL 进程管理
- session-scoped runtime environment
- slash-command 输入
- 本地 `@file` 引用注入
- output link
- 右侧 artifact preview
- interactive HTML iframe preview
- agent turn debug view

### Skill Artifact Runtime

当前 skill artifact flow 支持：

- session-scoped artifact directory
- `AGENT_UI_OUTPUT_DIR` 注入
- `agent-ui-skill-run` wrapper
- `manifest.json` artifact 记录
- `rich_display/html` 等输出类型
- 可点击 output link
- 交互式 HTML preview

wrapper 会输出结构化结果：

```text
AGENT_UI_SKILL_RUN_RESULT
skill: kline-chart
method: kline
run_id: ...
output_dir: ...
manifest: ...
outputs:
- chart.html | rich_display/html
```

### DeepSeek 适配

Astromere Agent 同时包含 DeepSeek / Anthropic-compatible API 适配工作：

- provider 配置
- runtime parameter guard
- DeepSeek-compatible tool result 处理
- stream-json 兼容修复
- model-specific control message 处理

---

## 示例：K-line Chart Skill

输入：

```text
/kline-chart @samples/kline_sample.csv 生成交互式图表
```

执行模型：

```text
skill: kline-chart
input: samples/kline_sample.csv
intent: 生成交互式 K 线图
```

输出：

```text
.agent-ui/<session-id>/kline-chart.xxx.html
```

结果是一个可以在桌面端右侧 preview 面板中打开的交互式 HTML artifact。

---

## Skill 设计原则

skill 应该尽量隐藏实现细节，不要把 runtime 细节暴露给用户或模型。

推荐职责划分：

```text
SKILL.md
  描述什么时候使用这个 skill，以及如何调用 wrapper。

agent-ui-skill-run
  解析 skill 实现。
  执行脚本。
  捕捉输出。
  写入 manifest metadata。

scripts/run.py
  执行实际的数据处理、分析或转换。
  内部读取 AGENT_UI_OUTPUT_DIR。
  写入 artifact。

Agent UI
  展示 output link。
  在 preview 面板中打开 rich artifact。
```

面向模型的 skill 指令不应该要求模型：

- 管理 output directory
- export 环境变量
- 猜测 artifact path
- 直接调用内部脚本
- 决定底层 runtime 细节

---

## 目录结构

```text
apps/
  agent-ui/
    src/
      app/App.tsx
      tauri.ts
    src-tauri/
      src/main.rs
    bin/
      agent-ui-skill-run

src/
  services/api/
  utils/model/
  tools/
  skills/
```

---

## 快速开始

### 安装依赖

```bash
bun install
```

桌面端 UI：

```bash
cd apps/agent-ui
npm install
```

### 运行 CLI

```bash
bun src/main.tsx -p "hello" --output-format text
```

### 运行 Desktop UI

```bash
cd apps/agent-ui
npm run tauri dev
```

---

## 当前状态

Astromere Agent 仍然是实验性项目。

当前重点是：

- conversational exploratory computing
- Jupyter-like runtime cell
- 可复用 skill function
- session-scoped artifact
- interactive rich display
- DeepSeek-compatible agent runtime
- desktop-first agent workflow

---

## Disclaimer

本仓库是 Claude Code 相关源码工作的研究 fork，不隶属于 Anthropic。请将其用于实验、本地开发和研究用途，并自行承担使用风险。
