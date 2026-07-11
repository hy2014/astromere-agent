"""helloworld component entry point.

Contract (source of truth = the `components` row in the DB; this component
declares one input port `Input` and one output port `output`, both `format=file`):

  * Input  : a *file card* delivered by the worker under the `Input` key —
             `{"path": "/abs/file.csv", "format": "csv"}`. The port name
             `Input` is part of the contract: the worker routes the upstream
             output port into this exact input port, so we read `data["Input"]`
             explicitly (we never scan all values looking for a `path`).
  * Output : JSON at $AGENT_UI_OUTPUT_PATH, keyed by the output port name
             `output`: `{"output": {"path": "/abs/new.csv", "format": "csv"}}`.

What it does: reads the input CSV, appends a `helloworld` column whose value is
the string "helloworld" on every row, and writes the result out as a new CSV so
a downstream node can keep consuming the file-card convention.

Run locally to smoke-test:
  echo '{"Input": {"path": "/tmp/sample.csv", "format": "csv"}}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
  cat out.json   # -> {"output": {"path": "/tmp/...csv", "format": "csv"}}
"""

import csv
import json
import os
import sys
import tempfile

# The input/output port names are part of this component's contract. If you
# rename a port in the component definition, you MUST rename it here too.
INPUT_PORT = "Input"
OUTPUT_PORT = "output"


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def run(data: dict) -> int:
    # Read the input file card by its declared port name — never scan all values.
    card = data.get(INPUT_PORT)
    if (
        not isinstance(card, dict)
        or not isinstance(card.get("path"), str)
        or not card["path"].strip()
    ):
        return fail(
            f"helloworld expects a file card on its '{INPUT_PORT}' input port, "
            f"got: {card!r}"
        )

    input_path = os.path.abspath(card["path"])
    if not os.path.isfile(input_path):
        return fail(f"input file not found: {input_path}")

    fmt = (card.get("format") or "").lower()
    is_csv = fmt == "csv" or input_path.lower().endswith(".csv")
    if not is_csv:
        return fail(
            f"helloworld only supports csv input (got format={fmt!r}); "
            f"convert the upstream file to csv"
        )

    with open(input_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))

    # Append the `helloworld` column (value "helloworld") to every row,
    # including the header row.
    out_rows = [row + ["helloworld"] for row in rows]

    out_fd, out_path = tempfile.mkstemp(suffix=".csv", prefix="helloworld-out-")
    os.close(out_fd)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(out_rows)

    result = {OUTPUT_PORT: {"path": out_path, "format": "csv"}}
    with open(os.environ["AGENT_UI_OUTPUT_PATH"], "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    print(
        f"helloworld: read {input_path} ({len(out_rows)} rows), "
        f"added 'helloworld' column -> {out_path}",
        flush=True,
    )
    return 0


def main() -> int:
    input_path = os.environ.get("AGENT_UI_INPUT_PATH")
    output_path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if not output_path:
        return fail("AGENT_UI_OUTPUT_PATH is not set")

    data = {}
    if input_path and os.path.exists(input_path):
        try:
            with open(input_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception as exc:
            return fail(f"failed to read input {input_path}: {exc}")
    else:
        print(f"WARN: input file missing ({input_path}), using empty input", file=sys.stderr)

    if not isinstance(data, dict):
        return fail("input must be a JSON object")

    return run(data)


if __name__ == "__main__":
    sys.exit(main())
