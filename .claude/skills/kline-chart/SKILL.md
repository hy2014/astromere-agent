---
name: kline-chart
description: Generate an interactive K-line/candlestick HTML chart from a CSV file with date, open, high, low, close, and optional volume columns.
allowed-tools:
  - Bash
  - Read
---

# Kline Chart Skill

Use this skill when the user asks to generate, draw, render, or visualize a candlestick/K-line/OHLC chart from a CSV file.

Input should be referenced with `@file`.

Supported column names:
- date: `date`, `datetime`, `time`, `timestamp`, `日期`, `交易日期`
- open: `open`, `o`, `开盘`, `开盘价`
- high: `high`, `h`, `最高`, `最高价`
- low: `low`, `l`, `最低`, `最低价`
- close: `close`, `c`, `收盘`, `收盘价`
- volume: `volume`, `vol`, `成交量` optional

## Execution

Always use `agent-ui-skill-run` so generated outputs are registered:

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill kline-chart \
  --method kline \
  --output-dir "$AGENT_UI_OUTPUT_DIR" \
  -- python3 "${CLAUDE_SKILL_DIR}/scripts/run.py" \
     --input <input_csv_path> \
     --output-dir "$AGENT_UI_OUTPUT_DIR"
```

After execution, summarize only the outputs reported by `agent-ui-skill-run`.
