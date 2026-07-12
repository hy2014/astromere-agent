# dataset-loader component

A **global** source component for the `engine_executor` DAG runtime (see
`docs/engine-executor.md`). It loads a local CSV or Parquet file, validates it,
reads lightweight metadata, and returns the file's absolute path so downstream
nodes can read the dataset directly from disk. It never rewrites the data.

## What it does

1. Reads the single parameter `file` (a local CSV/Parquet absolute path).
2. Validates the file exists and detects its format from the extension.
3. Writes the output JSON keyed by the `outputFile` port:

   ```json
   {"outputFile": {"path": "/abs/path/to/file.csv", "format": "csv"}}
   ```

   The `outputFile` output port carries the path; downstream nodes read
   `output["outputFile"]["path"]` and open the file directly.

## Input / Output

| | name | type | notes |
|---|---|---|---|
| input  | `file` | string | local CSV/Parquet file path |
| output | `outputFile` | string | absolute path of the file |

## Register it (global component)

In the app, open **注册组件** and fill:

- **名称**: `dataset-loader`
- **git 源 / 分支 / 入口**:
  - Local dev (no clone): set `gitUrl` to this folder's absolute path
    (`/path/to/your/clone/apps/agent-ui/components/dataset-loader`)
    — `engine_executor` uses a direct local directory and skips cloning.
  - Real repo later: `gitUrl` = the component's own git repo,
    `entryPoint` = `apps/agent-ui/components/dataset-loader/run.py`
    (relative to the cloned repo root), `gitBranch` = your branch.
- **执行入口**: `apps/agent-ui/components/dataset-loader/run.py`
- **配置项声明 (config_schema)** — paste exactly:

  ```json
  [
    {
      "key": "file",
      "label": "File",
      "type": "string",
      "required": false,
      "description": "输入选择的文件"
    }
  ]
  ```

- **输入端口**: none (it is a source node).
- **输出端口**: one port named `outputFile` (type `file`).

`verify_component` requires these files in the component root — all present:
`run.py`, `requirements.txt`, `SKILL.md`. (`component.json` 已于 2026-07-11 移除校验。)

## Run it standalone

```bash
echo '{"file":"/tmp/sample.csv"}' > /tmp/in.json
AGENT_UI_INPUT_PATH=/tmp/in.json AGENT_UI_OUTPUT_PATH=/tmp/out.json \
  python3 run.py
cat /tmp/out.json
```
