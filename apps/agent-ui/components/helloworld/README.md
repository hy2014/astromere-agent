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

Add a generic node and set its config to point at this folder:

```json
{
  "name": "helloworld",
  "gitUrl": "file:///Users/nazario.wang/workspace/claude-code/apps/agent-ui/components/helloworld",
  "gitBranch": "master",
  "entryPoint": "run.py",
  "args": { "text": "hello" },
  "inputs":  [{ "name": "text", "type": "csv" }],
  "outputs": [
    { "name": "text", "type": "csv" },
    { "name": "helloworld", "type": "csv" }
  ]
}
```

`gitUrl` **must be a git URL** — this component is its own git repository, so
reference it by its `file://` URL (a genuine git transport that `engine_executor`
clones through the same code path as a remote `https://` URL). For real
deployment, push this folder to a remote and use that URL instead. The engine
clones once per `(gitUrl, gitBranch)` and caches it under `ENGINE_EXECUTOR_CACHE_ROOT`.

(For dev-time convenience you may also point `gitUrl` at a plain local directory
path — the engine then skips the clone — but a real git URL is the intended
usage.)

## Run it standalone

```bash
echo '{"text":"hello"}' > /tmp/in.json
AGENT_UI_INPUT_PATH=/tmp/in.json AGENT_UI_OUTPUT_PATH=/tmp/out.json \
  python3 run.py
cat /tmp/out.json   # {"text": "hello", "helloworld": "hello-helloworld"}
```
