# dataset-loader

A source (global) component that loads a local **CSV or Parquet** file and hands
its path to the rest of the DAG. It does **not** copy or rewrite the
data — downstream nodes read the file directly from the returned path.

## When to use

- The first node of a DAG that needs tabular data sitting on local disk.
- Feeding a backtest / feature / training node with an existing dataset file.

## Parameters (config_schema)

| key  | type   | required | meaning                                    |
|------|--------|----------|--------------------------------------------|
| file | string | no       | absolute path to a local .csv/.parquet file |

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

## Notes

- Format is auto-detected from the file extension (.csv / .csv.gz / .parquet).
- The component only validates the path and reports it back — it never loads
  the file contents into memory, so it has no third-party runtime dependencies
  (see `requirements.txt`).
