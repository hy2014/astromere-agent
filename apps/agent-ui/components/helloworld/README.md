# helloworld component

The reference **file-consuming** component for the `engine_executor` DAG runtime
(see `docs/engine-executor.md`). It demonstrates the `format=file` card
convention end-to-end: it takes a CSV file from an upstream node, adds a
`helloworld` column (every cell = `"helloworld"`), and emits a new CSV file for
downstream nodes to consume.

## What it does

- **Reads its `Input` port:** the worker delivers the upstream file card under
  the `Input` key — `data["Input"] == {"path": "...", "format": "csv"}`. The
  port name `Input` is part of this component's contract, so the code reads it
  explicitly (it does **not** scan all inputs looking for a `path`).
- **Adds a `helloworld` column:** appends a column whose value is the string
  `"helloworld"` on every row (including the header), and writes a new CSV.
- **Emits a file card on `output`:** `{"output": {"path": "<new>.csv", "format": "csv"}}`
  for downstream nodes to consume.

## Input / Output

| | name | type | notes |
|---|---|---|---|
| input  | `Input` | file (csv) | a `format=file` card from an upstream node |
| output | `output` | file (csv) | a new csv with the added `helloworld` column |

## How to use it in a DAG

This component is **not** its own git repository — it lives as a folder
(`components/helloworld/`) **inside the current project repository**. So `gitUrl`
points at the **current repo**, and `entryPoint` carries the path to this
component *within* the cloned repo.

```json
{
  "name": "helloworld",
  "gitUrl": "git@github.com:hy2014/astromere-agent.git",
  "gitBranch": "dev",
  "entryPoint": "apps/agent-ui/components/helloworld/run.py",
  "inputs":  [{ "name": "Input", "type": "string", "format": "file" }],
  "outputs": [{ "name": "output", "type": "string", "format": "file" }]
}
```

- `gitUrl` **must be a git URL** — here it is the current repository
  (`git@github.com:hy2014/astromere-agent.git`; for local dev you can use
  `file:///Users/nazario.wang/workspace/claude-code`, which `engine_executor`
  clones through the same code path as a remote URL).
- `gitBranch` is the branch of the current repo that contains this component
  (`dev` here).
- `entryPoint` is the path to `run.py` **relative to the cloned repo root**
  (`apps/agent-ui/components/helloworld/run.py`), because the engine checks out
  the whole repo and runs the entry point from there.

The engine clones the whole repo once per `(gitUrl, gitBranch)` and caches it
under `ENGINE_EXECUTOR_CACHE_ROOT`; `entryPoint` is resolved against that clone
root, so the component is found at its subpath.

## Run it standalone

```bash
# file mode — feed it a csv file card on the `Input` port
echo '{"Input": {"path": "/tmp/sample.csv", "format": "csv"}}' > /tmp/in.json
AGENT_UI_INPUT_PATH=/tmp/in.json AGENT_UI_OUTPUT_PATH=/tmp/out.json \
  python3 run.py
cat /tmp/out.json   # {"output": {"path": "/tmp/helloworld-out-XXXX.csv", "format": "csv"}}
```
