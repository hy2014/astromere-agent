# Astromere Agent

[中文 README](README.zh-CN.md)

Astromere Agent is an experimental agent runtime and desktop UI for building **Jupyter-like exploratory workflows through conversation**.

The goal is not to expose more code to the user. The goal is to reduce the cost of exploration: instead of writing Python cells manually, users describe what they want, reference existing context or artifacts, and let the agent run reusable skills that produce rich, interactive outputs.

In short:

```text
skill + artifact/input reference + natural-language intent
=> exploratory result
```

This project is currently built as a fork of Claude Code, with additional work around DeepSeek compatibility, desktop UI, skill execution, and session-scoped artifacts.

> This project is a fork of `T-Lab-CUHKSZ/claude-code`. It is not affiliated with, endorsed by, or maintained by Anthropic.

---

## Why Jupyter-like?

Traditional Jupyter workflows are powerful because they combine:

- cells
- Python code
- reusable variables
- iterative exploration
- rich displays such as dataframes, charts, Plotly HTML, images, and reports

But traditional notebooks still require users to write and maintain code.

Astromere Agent explores a different interface:

```text
conversation as cells
skills as reusable analysis functions
artifacts as reusable runtime outputs
rich display as the notebook output layer
```

The user should not need to know how the underlying Python code works. They should be able to ask:

```text
/kline-chart @samples/kline_sample.csv Generate an interactive chart
```

and receive an interactive artifact that can be opened, previewed, referenced, and reused later.

---

## Core Design

### 1. Each conversation turn is a runtime cell

A user message is treated like a runtime cell.

It may contain:

- natural language requirements
- slash-command skill invocation
- file references through `@file`
- references to previously generated artifacts

The runtime cell can execute tools, call skills, and produce outputs.

### 2. Runtime cells produce rich-display artifacts

A cell output is not limited to text.

It can produce:

- interactive HTML
- tables / dataframes
- images
- JSON
- reports
- charts
- intermediate files used by later cells

The desktop UI can show generated artifacts as output links and render rich HTML in a right-side preview panel.

### 3. Artifacts become reusable context

Generated artifacts are stored under a session-scoped directory:

```text
<workspace>/.agent-ui/<session-id>/
```

Artifacts can be referenced by later turns, allowing the user to continue exploration without manually managing files.

Conceptually:

```text
turn A creates cleaned data
turn B references cleaned data and creates a chart
turn C references the chart/data and creates a report
```

### 4. Skills are reusable Python analysis functions

A skill is a reusable capability. It should behave like a high-level analysis function.

The model-facing instruction should stay simple. The user and model should not need to know the implementation details.

For example, the model calls:

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill kline-chart \
  --method kline \
  --input "/absolute/path/to/input.csv"
```

The wrapper resolves the implementation, runs the script, records artifacts, and emits structured output metadata.

### 5. The user explores through dialogue, not code

The intended workflow is:

```text
User intent + referenced data/artifacts
=> agent selects or runs a skill
=> skill produces rich artifact
=> user previews result
=> user asks follow-up question or reuses output
```

The user does not have to write Python, import libraries, manage variables, or remember file paths.

---

## Current Capabilities

### Desktop Agent UI

The desktop UI under `apps/agent-ui` provides:

- multi-session project sidebar
- stream-json REPL process management
- session-scoped runtime environment
- slash-command input
- local `@file` reference injection
- output links
- right-side artifact preview
- HTML iframe preview for interactive artifacts
- debug view for agent turns

### Skill Artifact Runtime

The skill artifact flow currently supports:

- session-scoped artifact directories
- `AGENT_UI_OUTPUT_DIR` injection
- `agent-ui-skill-run` wrapper
- `manifest.json` artifact records
- output classification such as `rich_display/html`
- clickable output links
- interactive HTML preview

The wrapper emits structured skill results:

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

### DeepSeek Adaptation

Astromere Agent also includes compatibility work for DeepSeek / Anthropic-compatible APIs:

- provider configuration
- runtime parameter guards
- DeepSeek-compatible tool result handling
- stream-json compatibility fixes
- model-specific control message handling

---

## Example: K-line Chart Skill

Input:

```text
/kline-chart @samples/kline_sample.csv Generate an interactive chart
```

Execution model:

```text
skill: kline-chart
input: samples/kline_sample.csv
intent: Generate an interactive K-line chart
```

Output:

```text
.agent-ui/<session-id>/kline-chart.xxx.html
```

The result is an interactive HTML artifact that can be opened in the desktop preview panel.

---

## Skill Design Principles

A skill should hide implementation details from the user and from the model whenever possible.

Recommended separation:

```text
SKILL.md
  Describes when and how to invoke the skill wrapper.

agent-ui-skill-run
  Resolves the skill implementation.
  Runs the script.
  Captures outputs.
  Writes manifest metadata.

scripts/run.py
  Performs the actual analysis or transformation.
  Reads AGENT_UI_OUTPUT_DIR internally.
  Writes artifacts.

Agent UI
  Displays output links.
  Opens rich artifacts in preview.
```

The model-facing skill instruction should not ask the model to:

- manage output directories
- export environment variables
- guess artifact paths
- call internal scripts directly
- decide low-level runtime details

---

## Repository Layout

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

## Quick Start

### Install dependencies

```bash
bun install
```

For the desktop UI:

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

## Status

Astromere Agent is experimental.

The current focus is:

- conversational exploratory computing
- Jupyter-like runtime cells
- reusable skill functions
- session-scoped artifacts
- interactive rich display
- DeepSeek-compatible agent runtime
- desktop-first agent workflow

---

## Disclaimer

This repository is a research fork of Claude Code-related source work. It is not affiliated with Anthropic. Use it for experimentation, local development, and research at your own risk.
