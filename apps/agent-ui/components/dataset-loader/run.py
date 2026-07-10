"""dataset-loader component entry point.

Reads a local CSV or Parquet file path supplied as the `filePath` parameter and
exposes it to the DAG as a `file` output. The component does NOT load or copy
the data — it only validates the path and reports it back so downstream nodes
read the file directly from disk.

Contract (see decisions/2026-07-10-dataset-component-design.md):
  * Input  : JSON at $AGENT_UI_INPUT_PATH. The single parameter `filePath` is
             the absolute path to a local CSV/Parquet file. It arrives as the
             node's `config.params` (source node -> no upstream). `filePath` is
             declared in the component's `config_schema` and filled per-instance
             by the user.
  * Output : JSON at $AGENT_UI_OUTPUT_PATH:
               {"path": "/abs/path/to/file.csv", "format": "csv" | "parquet"}
             Downstream nodes connect to the `data` output port and read `path`
             from their own input.

Smoke-test:
  echo '{"filePath":"/tmp/sample.csv"}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
"""

import json
import os
import sys


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def detect_format(path: str) -> str:
    """Return 'csv' or 'parquet', or '' if the extension is unsupported."""
    lower = path.lower()
    if lower.endswith((".csv", ".csv.gz", ".csv.zip")):
        return "csv"
    if lower.endswith((".parquet", ".pq", ".parq")):
        return "parquet"
    return ""


def main() -> int:
    input_path = os.environ.get("AGENT_UI_INPUT_PATH")
    output_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if not input_path or not output_path:
        return fail("AGENT_UI_INPUT_PATH / AGENT_UI_OUTPUT_PATH must be set")

    try:
        with open(input_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        return fail(f"failed to read input {input_path}: {exc}")

    if not isinstance(data, dict):
        return fail("input must be a JSON object")

    raw = data.get("filePath", "")
    if not isinstance(raw, str) or not raw.strip():
        return fail("missing required parameter `filePath` (local CSV/Parquet file)")

    path = os.path.abspath(raw)
    if not os.path.isfile(path):
        return fail(f"filePath does not exist or is not a file: {path}")

    fmt = detect_format(path)
    if not fmt:
        return fail(f"unsupported file type (need .csv/.csv.gz/.parquet): {path}")

    result = {"path": path, "format": fmt}

    try:
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        return fail(f"failed to write output {output_path}: {exc}")

    print(f"dataset-loader: {path} ({fmt})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
