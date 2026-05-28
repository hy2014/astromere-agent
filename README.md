# Astromere Agent

[中文文档](README.zh-CN.md)

Astromere Agent is an experimental **desktop coding agent** built on top of Claude Code. It provides a native GUI for working with AI agents across multiple sessions, with rich artifact preview and slash-command extensibility.

> This project is a fork of `T-Lab-CUHKSZ/claude-code`. It is not affiliated with, endorsed by, or maintained by Anthropic.

---

## Features

### Desktop GUI (`apps/agent-ui`)

A Tauri-based native desktop application that wraps the Claude Code agent runtime:

- **Multi-session management** — project sidebar with independent agent sessions
- **Stream-json REPL** — real-time agent output streaming
- **Slash-command input** — invoke skills inline (e.g. `/kline-chart`)
- **`@file` reference** — inject local file paths into conversation
- **Artifact preview panel** — view generated HTML, charts, and rich outputs in the right-side panel
- **Interactive HTML iframe** — render interactive artifacts directly
- **Debug view** — inspect agent turns and tool calls

### Agent Runtime

- Full Claude Code CLI agent runtime
- DeepSeek / Anthropic-compatible API support
- Session-scoped working directories
- Skill-based extensibility (see [Skill Design](docs/skill-design.md))

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.x
- [Node.js](https://nodejs.org) >= 18
- [Rust toolchain](https://rustup.rs) (for Tauri desktop build)

### Install dependencies

```bash
# Root dependencies (agent runtime)
bun install

# Desktop UI dependencies
cd apps/agent-ui
npm install
```

### Run the desktop UI

```bash
cd apps/agent-ui
npm run tauri dev
```

### Run the CLI (headless)

```bash
bun src/main.tsx -p "your prompt here" --output-format text
```

---

## Project Structure

```text
apps/
  agent-ui/           # Tauri desktop application
    src/              # React frontend
    src-tauri/        # Rust backend (Tauri)
    bin/              # CLI wrappers (e.g. agent-ui-skill-run)

src/                  # Agent runtime (Claude Code core)
  services/api/
  utils/model/
  tools/
  skills/

.claude/skills/       # Installed slash-command skills
samples/              # Sample data files
```

---

## Status

Astromere Agent is **experimental** and under active development. Many features are being iterated on — expect breaking changes.

Current development focus:
- Desktop GUI stability and UX polish
- Skill system and artifact management
- DeepSeek-compatible agent runtime
- Session lifecycle and workspace management

---

## Disclaimer

This repository is a research fork of Claude Code-related source work. It is not affiliated with Anthropic. Use it for experimentation, local development, and research at your own risk.
