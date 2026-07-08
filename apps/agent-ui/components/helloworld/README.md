# helloworld component

A minimal example component for the `engine_executor` DAG runtime (see
`docs/engine-executor.md`).

## What it does

Reads a JSON input, echoes it, and appends a `helloworld` column computed as
`"{text}-helloworld"`. It is the reference component used by the end-to-end test
(`src-tauri/tests/executor_e2e.rs`).

## Input / Output

| | name | type | notes |
|---|---|---|---|
| input  | `text` | string | echoed through |
| output | `text` | string | same as input |
| output | `helloworld` | string | `{text}-helloworld` |

The full input object is also passed through, so any extra `args` keys survive.

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
  "args": { "text": "hello" },
  "inputs":  [{ "name": "text", "type": "csv" }],
  "outputs": [
    { "name": "text", "type": "csv" },
    { "name": "helloworld", "type": "csv" }
  ]
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
echo '{"text":"hello"}' > /tmp/in.json
AGENT_UI_INPUT_PATH=/tmp/in.json AGENT_UI_OUTPUT_PATH=/tmp/out.json \
  python3 run.py
cat /tmp/out.json   # {"text": "hello", "helloworld": "hello-helloworld"}
```
