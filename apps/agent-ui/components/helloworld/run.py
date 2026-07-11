"""helloworld component entry point.

Contract (see decisions/2026-07-11-helloworld-consume-file.md; source of truth =
the `components` row in the DB, where `Input`/`output` are declared `format=file`):

  * Input  : JSON at $AGENT_UI_INPUT_PATH.
             - File mode (default when chained): the upstream edge delivers a
               *file card* — `{"path": "/abs/file.csv", "format": "csv"}` — under
               the `Input` port (the worker routes the upstream `outputFile` port
               into whatever input port you wired it to, so we scan every input
               value for a dict with a `path` key).
             - Scalar fallback: a standalone/source node with `params={"text": "hi"}`
               gets `{"text": "hi"}` and we just echo it (kept for quick local
               smoke-tests and the engine e2e test).
  * Output : JSON at $AGENT_UI_OUTPUT_PATH, keyed by the output port name `output`:
             - File mode:  {"output": {"path": "/abs/new.csv", "format": "csv"}}
                           a NEW csv with an added `helloworld` column.
             - Scalar mode: {"text": "hi", "helloworld": "hi-helloworld"}

What it does: reads the input CSV, appends a `helloworld` column whose value is
the string "helloworld" on every row, and writes the result out as a new CSV so
a downstream node can keep consuming the file-card convention.

Run locally to smoke-test:
  # file mode
  echo '{"Input": {"path": "/tmp/sample.csv", "format": "csv"}}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
  cat out.json   # -> {"output": {"path": "/tmp/...csv", "format": "csv"}}
  # scalar mode
  echo '{"text":"hello"}' > in.json
  AGENT_UI_INPUT_PATH=in.json AGENT_UI_OUTPUT_PATH=out.json python3 run.py
  cat out.json   # -> {"text": "hello", "helloworld": "hello-helloworld"}
"""

import csv
import json
import os
import sys
import tempfile


def fail(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return 1


def find_file_card(data) -> dict | None:
    """Return the first `{"path": ...}` file card found in the input payload.

    The worker hands us the upstream `outputFile` card under whatever input port
    name it was wired to, so we look at every input value rather than a fixed key.
    """
    if isinstance(data, dict):
        for value in data.values():
            if (
                isinstance(value, dict)
                and isinstance(value.get("path"), str)
                and value["path"].strip()
            ):
                return value
    return None


def run_file_mode(card: dict) -> int:
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

    result = {"output": {"path": out_path, "format": "csv"}}
    with open(os.environ["AGENT_UI_OUTPUT_PATH"], "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    print(
        f"helloworld: read {input_path} ({len(out_rows)} rows), "
        f"added 'helloworld' column -> {out_path}",
        flush=True,
    )
    return 0


def run_scalar_mode(data: dict) -> int:
    text = data.get("text", "")
    if not isinstance(text, str):
        text = str(text)
    result = {"text": text, "helloworld": f"{text}-helloworld"}
    with open(os.environ["AGENT_UI_OUTPUT_PATH"], "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(f"helloworld component ran: text={text!r} -> helloworld column added", flush=True)
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

    card = find_file_card(data)
    if card is not None:
        return run_file_mode(card)
    return run_scalar_mode(data)


if __name__ == "__main__":
    sys.exit(main())
