"""helloworld component entry point.

Contract (see docs/engine-executor.md):
  * Input  : JSON file at $AGENT_UI_INPUT_PATH. The DAG node's `args` are merged
             into the input object by the worker, so e.g. args {"text": "hello"}
             arrive as {"text": "hello", ...}.
  * Output : JSON file written to $AGENT_UI_OUTPUT_PATH. This component echoes
             the input and appends a `helloworld` column so downstream consumers
             (or a test) can verify the data was transformed.

Run locally to smoke-test:
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
"""

import json
import os
import sys


def main() -> int:
    input_path = os.environ.get("AGENT_UI_INPUT_PATH")
    output_path = os.environ.get("AGENT_UI_OUTPUT_PATH")

    if not output_path:
        print("ERROR: AGENT_UI_OUTPUT_PATH is not set", file=sys.stderr)
        return 1

    data = {}
    if input_path and os.path.exists(input_path):
        try:
            with open(input_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:  # surface a clear error in the execution logs
            print(f"ERROR: failed to read input {input_path}: {exc}", file=sys.stderr)
            return 1
    else:
        print(f"WARN: input file missing ({input_path}), using empty input", file=sys.stderr)

    if not isinstance(data, dict):
        print("ERROR: input must be a JSON object", file=sys.stderr)
        return 1

    text = data.get("text", "")

    # Echo the original fields, then add the `helloworld` column.
    result = dict(data)
    result["helloworld"] = f"{text}-helloworld" if text else "helloworld"

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"helloworld component ran: text={text!r} -> helloworld column added", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
