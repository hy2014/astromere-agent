# Astromere Agent

[中文 README](README.zh-CN.md)

Astromere Agent is a research-oriented fork of Claude Code focused on adapting the agent runtime to alternative model providers and a desktop-first workflow.

This fork currently focuses on two major directions:

1. **DeepSeek-compatible Claude Code runtime**
2. **Desktop Agent UI with Jupyter-like skill artifacts**

> This project is a fork of `T-Lab-CUHKSZ/claude-code`. 

---

## Highlights

### DeepSeek adaptation

Astromere Agent adds compatibility work for running Claude Code-style agent flows against DeepSeek / Anthropic-compatible endpoints.

The adaptation work includes:

- Model configuration support for non-Anthropic providers
- DeepSeek-compatible request and response handling
- Runtime guards for unsupported model parameters
- Stream-json compatibility fixes for tool calls and tool results
- Model-specific handling for runtime control messages
- Safer handling of connector text blocks and provider-specific behavior

### Desktop Agent UI

This repository adds a desktop UI under `apps/agent-ui`.

The desktop UI is designed around long-running coding sessions and agent workflows:

- Multi-session desktop interface
- Project/session sidebar
- Claude Code stream-json REPL bridge
- Process lifecycle management for agent sessions
- Runtime status and debug inspection
- Local `@file` reference injection
- Slash-command skill entry
- Rich artifact preview panel

### Jupyter-like skill artifacts

Astromere Agent adds a skill/artifact workflow inspired by notebooks:

- Type `/` to open slash commands
- Select a skill such as `/kline-chart`
- Reference local files with `@file`
- Run skills through `agent-ui-skill-run`
- Store generated artifacts under a session-scoped `.agent-ui/<session-id>/` directory
- Record outputs in `manifest.json`
- Render rich HTML artifacts in the desktop preview panel

The skill wrapper captures generated files and emits a structured result block:

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

The UI can expose output links and preview HTML artifacts on the right side of the desktop app.

---

## Repository Layout

```text
apps/
  agent-ui/                 Desktop Agent UI
    src/
      app/App.tsx           Main React UI
      tauri.ts              Tauri command bridge
    src-tauri/
      src/main.rs           Desktop backend / process manager
    bin/
      agent-ui-skill-run    Skill wrapper and artifact registrar

src/
  services/api/             Model provider API layer
  utils/model/              Model validation / compatibility logic
  tools/                    Claude Code tool system
  skills/                   Skill system support
```

---

## Quick Start

### Prerequisites

- Bun
- Node.js / npm
- Rust toolchain
- Tauri prerequisites for your platform
- A valid API key for your configured model provider

### Install dependencies

```bash
bun install
```

For the desktop app:

```bash
cd apps/agent-ui
npm install
```

### Run the CLI

```bash
bun src/main.tsx -p "hello" --output-format text
```

### Run the desktop UI

```bash
cd apps/agent-ui
npm run tauri dev
```

---

## Desktop Skill Flow

A typical skill flow looks like this:

```text
/kline-chart @samples/kline_sample.csv Generate a chart
```

The UI sends the prompt plus local file reference context to the agent runtime.

The model is expected to call the wrapper:

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill kline-chart \
  --method kline \
  --input "/absolute/path/to/input.csv"
```

The wrapper resolves the skill implementation, runs the skill script, captures generated files, updates `manifest.json`, and emits structured artifact metadata.

Skill scripts should read `AGENT_UI_OUTPUT_DIR` internally and write artifacts into that directory. The model should not manually manage output directories.

---

## Artifact Model

Artifacts are session-scoped:

```text
<workspace>/.agent-ui/<session-id>/
```

Each skill run may create or update:

```text
manifest.json
*.html
*.csv
*.json
*.png
...
```

The wrapper classifies outputs such as:

```text
rich_display/html
rich_display/image
artifact/table
artifact/json
artifact/file
```

HTML artifacts can be opened in the right-side preview panel through sandboxed iframe rendering.

---

## Skill Design Principles

A skill should keep runtime details out of the model-facing instructions.

Recommended division of responsibility:

- `SKILL.md` tells the model how to invoke the wrapper.
- `agent-ui-skill-run` resolves the skill directory and records artifacts.
- The skill script performs the actual business logic.
- The script reads `AGENT_UI_OUTPUT_DIR` internally.
- The UI displays published artifacts through links and preview panels.

The model-facing skill instructions should not ask the model to manage output directories, export environment variables, or call implementation scripts directly.

---

## DeepSeek Notes

Astromere Agent includes provider compatibility work for DeepSeek-style Anthropic-compatible APIs.

The goal is not just to switch an endpoint. The runtime needs to account for model-specific differences in:

- Thinking / reasoning support
- Tool result format
- Unsupported parameters
- Runtime control messages
- Consecutive tool result merging
- Error status propagation

---

## Development Notes

Useful commands:

```bash
# Frontend
cd apps/agent-ui
npm run dev

# Tauri desktop
npm run tauri dev

# Rust backend check
cd apps/agent-ui/src-tauri
cargo check
```

For repository remotes, a common fork setup is:

```bash
git remote -v
git remote set-url origin git@github.com:hy2014/astromere-agent.git
git remote add upstream https://github.com/T-Lab-CUHKSZ/claude-code.git
```

Use `origin` for your fork and `upstream` to sync with the original fork source.

---

## Status

This fork is experimental and research-oriented.

Recently added:

- Desktop Agent UI
- Session-scoped agent runtime
- UUID-backed session IDs
- Stream-json REPL process management
- Skill artifact wrapper
- Manifest-backed artifact outputs
- HTML rich preview
- Slash-command and `@file` input UX
- DeepSeek compatibility work

---

## Disclaimer

This repository is a research fork of Claude Code-related source work. It is not affiliated with Anthropic. Use it for experimentation, local development, and research at your own risk.
