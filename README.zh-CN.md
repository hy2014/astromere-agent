# Astromere Agent

[English README](README.md)

Astromere Agent 是一个实验性的 **桌面端 coding agent**，基于 Claude Code 构建。它提供了原生 GUI，支持多会话管理、富内容预览和 slash-command 可扩展能力。

> 本项目 fork 自 `T-Lab-CUHKSZ/claude-code`。本项目不隶属于 Anthropic，也不由 Anthropic 维护或背书。

---

## 功能

### Desktop GUI（`apps/agent-ui`）

基于 Tauri 的原生桌面应用，封装了 Claude Code agent runtime：

- **多会话管理** — 项目侧边栏，支持独立的 agent 会话
- **Stream-json REPL** — 实时 agent 输出流
- **Slash-command 输入** — 内联调用 skill（如 `/kline-chart`）
- **`@file` 引用** — 将本地文件路径注入对话
- **Artifact preview 面板** — 在右侧面板预览生成的 HTML、图表等富内容
- **交互式 HTML iframe** — 直接渲染交互式 artifact
- **Debug 视图** — 检查 agent 的推理步骤和工具调用

### Agent Runtime

- 完整的 Claude Code CLI agent runtime
- DeepSeek / Anthropic-compatible API 支持
- 会话隔离的工作目录
- 基于 skill 的可扩展机制（参见 [Skill 设计文档](docs/skill-design.zh-CN.md)）

---

## 快速开始

### 前置要求

- [Bun](https://bun.sh) >= 1.x
- [Node.js](https://nodejs.org) >= 18
- [Rust 工具链](https://rustup.rs)（用于 Tauri 桌面构建）

### 安装依赖

```bash
# 根目录依赖（agent runtime）
bun install

# Desktop UI 依赖
cd apps/agent-ui
npm install
```

### 运行桌面 UI

```bash
cd apps/agent-ui
npm run tauri dev
```

### 运行 CLI（无界面模式）

```bash
bun src/main.tsx -p "你的提示" --output-format text
```

---

## 项目结构

```text
apps/
  agent-ui/           # Tauri 桌面应用
    src/              # React 前端
    src-tauri/        # Rust 后端（Tauri）
    bin/              # CLI 包装脚本（如 agent-ui-skill-run）

src/                  # Agent runtime（Claude Code 核心）
  services/api/
  utils/model/
  tools/
  skills/

.claude/skills/       # 已安装的 slash-command skill
samples/              # 示例数据文件
```

---

## 状态

Astromere Agent **处于实验阶段**，正在积极开发中。许多功能仍在迭代——可能发生破坏性变更。

当前开发重点：
- Desktop GUI 稳定性和 UX 打磨
- Skill 系统和 artifact 管理
- DeepSeek-compatible agent runtime
- 会话生命周期和工作区管理

---

## Disclaimer

本仓库是 Claude Code 相关源码工作的研究 fork，不隶属于 Anthropic。请将其用于实验、本地开发和研究用途，并自行承担使用风险。
