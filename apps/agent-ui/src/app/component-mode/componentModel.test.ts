import {test} from "node:test";
import assert from "node:assert/strict";
import type {ConfigSchemaItem} from "../../types";
import {
  buildSchemaType,
  isListType,
  mergeInstanceParams,
  normalizeSchemaType,
  parseConfigSchema,
  validateConfigSchemaDef,
  validateInstanceConfig,
  validateInstanceValue,
} from "./componentModel";

const yearItem: ConfigSchemaItem = {
  key: "year",
  label: "年份",
  type: "number",
  required: true,
};

const modeItem: ConfigSchemaItem = {
  key: "mode",
  label: "模式",
  type: "enum",
  required: false,
  enum: ["full", "incremental"],
};

test("parseConfigSchema tolerates null/undefined", () => {
  assert.deepEqual(parseConfigSchema(undefined), []);
  assert.deepEqual(parseConfigSchema(null), []);
  assert.deepEqual(parseConfigSchema("nope"), []);
});

test("parseConfigSchema normalizes list types", () => {
  const items = parseConfigSchema([
    {key: "tags", label: "标签", type: {kind: "list", element: "string"}, required: false},
  ]);
  assert.equal(items.length, 1);
  assert.equal(isListType(items[0].type), true);
  assert.deepEqual(items[0].type, {kind: "list", element: "string"});
});

test("normalizeSchemaType accepts both shapes", () => {
  assert.deepEqual(normalizeSchemaType("number"), "number");
  assert.deepEqual(normalizeSchemaType({kind: "list", element: "number"}), {
    kind: "list",
    element: "number",
  });
});

test("buildSchemaType round-trips a list element", () => {
  const t = buildSchemaType("list", "boolean");
  assert.equal(isListType(t), true);
  if (isListType(t)) assert.equal(t.element, "boolean");
});

test("validateInstanceValue: required empty fails, optional empty passes", () => {
  assert.equal(validateInstanceValue(yearItem, ""), "必填");
  assert.equal(validateInstanceValue(yearItem, undefined), "必填");
  assert.equal(validateInstanceValue(modeItem, ""), null);
});

test("validateInstanceValue: number type checking", () => {
  assert.equal(validateInstanceValue(yearItem, 2024), null);
  assert.equal(validateInstanceValue(yearItem, "2024"), null); // numeric string ok
  assert.equal(validateInstanceValue(yearItem, "abc"), "应为数字");
});

test("validateInstanceValue: enum membership", () => {
  assert.equal(validateInstanceValue(modeItem, "full"), null);
  assert.equal(validateInstanceValue(modeItem, "bogus"), "不在可选范围");
});

test("validateInstanceValue: list element type", () => {
  const item: ConfigSchemaItem = {
    key: "nums",
    label: "数字列表",
    type: {kind: "list", element: "number"},
    required: false,
  };
  assert.equal(validateInstanceValue(item, [1, 2, 3]), null);
  assert.equal(validateInstanceValue(item, [1, "x"]), "应为数字");
  assert.equal(validateInstanceValue(item, "not-array"), "应为列表");
});

test("validateInstanceConfig aggregates per-key errors", () => {
  const schema = [yearItem, modeItem];
  const errors = validateInstanceConfig(schema, {year: "", mode: "full"});
  assert.deepEqual(errors, {year: "必填"});
  const ok = validateInstanceConfig(schema, {year: 2024, mode: "full"});
  assert.deepEqual(ok, {});
});

test("validateConfigSchemaDef catches empty and duplicate keys", () => {
  const errors = validateConfigSchemaDef([
    {key: "", label: "", type: "string", required: false},
    {key: "year", label: "", type: "string", required: false},
    {key: "year", label: "", type: "string", required: false},
  ] as ConfigSchemaItem[]);
  assert.equal(errors[0], "key 不能为空");
  assert.equal(errors[2], "key 重复");
});

test("validateConfigSchemaDef requires enum options", () => {
  const errors = validateConfigSchemaDef([
    {key: "m", label: "", type: "enum", required: false},
  ] as ConfigSchemaItem[]);
  assert.equal(errors[0], "enum 需选项");
});

// ─── mergeInstanceParams (free-form run-param editor) ──────────────────────

test("mergeInstanceParams free-form: deleted keys stay deleted", () => {
  // Regression: deleted free-form rows were resurrected from `existing` by a
  // "preserve legacy keys" loop, so they reappeared after reselecting the node.
  const existing = {
    "A": "",
    "`script.module": "",
    "`script.module`": "",
    a: "B",
    "script.module": "jobs.daily_job",
  };
  // The editor committed everything except the two backtick-typo keys.
  const next = {
    A: "",
    a: "B",
    "script.module": "jobs.daily_job",
  };
  const merged = mergeInstanceParams(existing, next, []);
  assert.deepEqual(merged, next);
  assert.ok(!("`script.module" in merged));
  assert.ok(!("`script.module`" in merged));
});

test("mergeInstanceParams free-form: edited value overwrites existing", () => {
  const merged = mergeInstanceParams(
    {date: "2026-01-01", mode: "full"},
    {date: "2026-02-02", mode: "full"},
    [],
  );
  assert.deepEqual(merged, {date: "2026-02-02", mode: "full"});
});

test("mergeInstanceParams free-form: added keys are appended", () => {
  const merged = mergeInstanceParams(
    {a: "1"},
    {a: "1", b: "2"},
    [],
  );
  assert.deepEqual(merged, {a: "1", b: "2"});
});

test("mergeInstanceParams preserves system./dw. keys even in free-form mode", () => {
  // Those keys belong to other tabs; the run-param editor must never drop them.
  const merged = mergeInstanceParams(
    {"system.python_path": "/usr/bin/python3", "dw.enabled": true, date: "x"},
    {date: "x"},
    [],
  );
  assert.deepEqual(merged, {
    "system.python_path": "/usr/bin/python3",
    "dw.enabled": true,
    date: "x",
  });
});

test("mergeInstanceParams schema mode: undeclared legacy keys are preserved", () => {
  // The structured form only enumerates declared keys; an undeclared key
  // absent from `next` must survive the save.
  const merged = mergeInstanceParams(
    {year: 2024, legacy: "keep"},
    {year: 2025},
    ["year"],
  );
  assert.deepEqual(merged, {year: 2025, legacy: "keep"});
});

test("mergeInstanceParams schema mode: deleting via overlay still works", () => {
  // An undeclared key that IS present in `next` (e.g. cleared to "") follows
  // the editor value rather than being force-kept.
  const merged = mergeInstanceParams(
    {year: 2024, legacy: "keep"},
    {year: 2025, legacy: ""},
    ["year"],
  );
  assert.deepEqual(merged, {year: 2025, legacy: ""});
});

test("mergeInstanceParams schema mode: system./dw. keys preserved", () => {
  const merged = mergeInstanceParams(
    {"system.python_path": "/py", year: 2024},
    {year: 2025},
    ["year"],
  );
  assert.deepEqual(merged, {"system.python_path": "/py", year: 2025});
});
