# dataset-loader

A source (global) component that exposes a local **CSV or Parquet** file's
absolute path to the rest of the DAG. It validates the path, auto-detects the
format from the file extension, and hands the result downstream. It does **not**
load, copy, or rewrite the data — downstream nodes read the file directly from
the returned path.

## When to use

- The first node of a DAG that needs tabular data already sitting on the worker's
  local disk.
- Feeding a backtest / feature / training node with an existing dataset file.
- If your file lives on a remote URL or S3, use **data-loader** instead
  (downloads to the run dir first) — this component expects the file to exist
  locally already.

## Parameters (config_schema)

| key  | type   | required | meaning                                    |
|------|--------|----------|--------------------------------------------|
| file | string | **yes**  | absolute path to a local .csv/.parquet file |

## Output ports

| port       | type   | meaning                                                   |
|------------|--------|-----------------------------------------------------------|
| outputFile | string | absolute path of the file (downstream reads it from disk) |

The output JSON written to `AGENT_UI_OUTPUT_PATH` is keyed by the port name
`outputFile`:

```json
{"outputFile": {"path": "<absolute path>", "format": "csv" | "parquet"}}
```

Downstream nodes connect to the `outputFile` port and read `output["outputFile"]["path"]`.

## Register it

In the app, open **注册组件** and fill:

| 字段 | 值 |
|------|----|
| 名称 | `dataset-loader` |
| git 源 | `git@github.com:hy2014/astromere-agent.git` |
| 分支 | `dev` |
| 执行入口 | `apps/agent-ui/components/dataset-loader/run.py` |
| 全局组件 | ✅ |
| 输入端口 | 0 个 |
| 输出端口 | 1 个：`outputFile`（type=file） |

config_schema — paste exactly:

```json
[
  {
    "key": "file",
    "label": "文件路径",
    "type": "string",
    "required": true,
    "description": "worker 机器上的本地 CSV/Parquet 文件绝对路径"
  }
]
```

## Notes

- Format is auto-detected from the file extension (.csv / .csv.gz / .csv.zip /
  .parquet / .pq / .parq). Unknown extensions → hard fail.
- This component never loads the file contents into memory, so it has zero
  third-party runtime dependencies (pure stdlib).
- Full design: see `DESIGN.md` in this directory.
