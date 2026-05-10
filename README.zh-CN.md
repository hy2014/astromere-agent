# Astromere Agent

[English README](README.md)

Astromere Agent 是一个面向研究和本地开发的 Claude Code fork，重点是让原有 agent runtime 更好地适配非 Anthropic 模型供应商，并提供更适合桌面端长会话工作的 Agent UI。

这个 fork 目前主要关注两个方向：

1. **DeepSeek 兼容的 Claude Code runtime**
2. **带 Jupyter-like skill artifact 能力的 Desktop Agent UI**

> 本项目 fork 自 `T-Lab-CUHKSZ/claude-code`。

---

## 主要特性

### DeepSeek 适配

Astromere Agent 增加了对 DeepSeek / Anthropic-compatible endpoint 的适配，使 Claude Code 风格的 agent 流程可以运行在不同模型供应商之上。

相关工作包括：

- 非 Anthropic provider 的模型配置支持
- DeepSeek 兼容的请求与响应处理
- 不支持参数的 runtime guard
- stream-json 模式下 tool call / tool result 的兼容修复
- model-specific runtime control message 处理
- connector text block 与 provider-specific 行为的更安全处理

### Desktop Agent UI

本仓库在 `apps/agent-ui` 下新增了一个桌面端 UI。

这个 UI 面向长时间 coding session 和 agent 工作流设计：

- 多 session 桌面界面
- 项目 / 会话侧边栏
- Claude Code stream-json REPL bridge
- agent session 进程生命周期管理
- runtime 状态与 debug 检查
- 本地 `@file` 引用注入
- slash-command skill 输入
- 右侧 rich artifact preview 面板

### Jupyter-like Skill Artifacts

Astromere Agent 增加了一套类似 Notebook 的 skill/artifact 工作流：

- 输入 `/` 打开 slash commands
- 选择 `/kline-chart` 这样的 skill
- 使用 `@file` 引用本地文件
- 通过 `agent-ui-skill-run` 运行 skill
- 将生成的 artifact 存储到 session 级目录 `.agent-ui/<session-id>/`
- 在 `manifest.json` 中记录输出
- 在桌面端右侧 preview 面板中渲染 HTML artifact

skill wrapper 会捕捉生成文件，并输出结构化结果：

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

UI 可以基于这个结果展示 output link，并在右侧打开 HTML preview。

---

## 目录结构

```text
apps/
  agent-ui/                 Desktop Agent UI
    src/
      app/App.tsx           React 主界面
      tauri.ts              Tauri command bridge
    src-tauri/
      src/main.rs           桌面端后端 / 进程管理
    bin/
      agent-ui-skill-run    skill wrapper 与 artifact registrar

src/
  services/api/             模型 provider API 层
  utils/model/              模型校验 / 兼容逻辑
  tools/                    Claude Code tool 系统
  skills/                   skill 系统支持
```

---

## 快速开始

### 环境要求

- Bun
- Node.js / npm
- Rust toolchain
- 当前平台所需的 Tauri 依赖
- 已配置的模型供应商 API key

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

## Desktop Skill Flow

一个典型的 skill 使用方式：

```text
/kline-chart @samples/kline_sample.csv 生成图表
```

UI 会把用户 prompt 和本地文件引用上下文一起发送给 agent runtime。

模型只需要调用 wrapper：

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill kline-chart \
  --method kline \
  --input "/absolute/path/to/input.csv"
```

wrapper 会自己解析 skill 实现、运行 skill 脚本、捕捉生成文件、更新 `manifest.json`，并输出结构化 artifact metadata。

skill 脚本应该在内部读取 `AGENT_UI_OUTPUT_DIR`，并把 artifact 写入这个目录。模型不应该手动管理 output directory。

---

## Artifact 模型

artifact 按 session 隔离：

```text
<workspace>/.agent-ui/<session-id>/
```

每次 skill run 可能创建或更新：

```text
manifest.json
*.html
*.csv
*.json
*.png
...
```

wrapper 会将输出分类为：

```text
rich_display/html
rich_display/image
artifact/table
artifact/json
artifact/file
```

HTML artifact 可以通过右侧 preview 面板打开，并使用 sandboxed iframe 渲染。

---

## Skill 设计原则

skill 应该尽量把 runtime 细节藏在模型不可见的地方。

推荐职责划分：

- `SKILL.md` 只告诉模型如何调用 wrapper。
- `agent-ui-skill-run` 负责解析 skill 目录并记录 artifact。
- skill script 负责实际业务逻辑。
- script 内部读取 `AGENT_UI_OUTPUT_DIR`。
- UI 通过 output link 和 preview panel 展示 artifact。

面向模型的 skill 指令不应该要求模型管理输出目录、export 环境变量，或直接调用内部实现脚本。

---

## DeepSeek 说明

Astromere Agent 包含对 DeepSeek 风格 Anthropic-compatible API 的兼容工作。

这里的目标不只是切换 endpoint。runtime 还需要处理不同模型之间的行为差异，例如：

- Thinking / reasoning 支持情况
- Tool result 格式
- 不支持的参数
- Runtime control message
- 连续 tool result 合并
- Error status 传播

---

## 开发说明

常用命令：

```bash
# 前端
cd apps/agent-ui
npm run dev

# Tauri desktop
npm run tauri dev

# Rust backend 检查
cd apps/agent-ui/src-tauri
cargo check
```

如果你是从上游 fork，本地 remote 可以这样配置：

```bash
git remote -v
git remote set-url origin git@github.com:hy2014/astromere-agent.git
git remote add upstream https://github.com/T-Lab-CUHKSZ/claude-code.git
```

`origin` 用于推送自己的 fork，`upstream` 用于同步原始 fork source 的更新。

---

## 当前状态

这个 fork 仍然是实验性和研究导向的。

近期新增能力包括：

- Desktop Agent UI
- session-scoped agent runtime
- UUID-backed session IDs
- stream-json REPL 进程管理
- skill artifact wrapper
- manifest-backed artifact outputs
- HTML rich preview
- slash-command 和 `@file` 输入体验
- DeepSeek 兼容工作

---

## Disclaimer

本仓库是 Claude Code 相关源码工作的研究 fork，不隶属于 Anthropic。请将其用于实验、本地开发和研究用途，并自行承担使用风险。
