import {test} from "node:test";
import assert from "node:assert/strict";
import type {ConfigSchemaItem} from "../../types";
import {
  buildSchemaType,
  isListType,
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
