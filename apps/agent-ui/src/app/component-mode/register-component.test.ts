import {test} from "node:test";
import assert from "node:assert/strict";
import type {Component} from "../../types";
import {
  assembleRegisterComponent,
  assembleUpdateComponent,
  canSubmitRegister,
  type RegisterComponentInput,
} from "./componentModel";

const baseInput: RegisterComponentInput = {
  name: "my-comp",
  description: "desc",
  gitUrl: "git@x/y.git",
  gitBranch: "main",
  gitRef: "v1",
  entryPoint: "run.py",
  configSchema: [],
  inputPorts: [],
  outputPorts: [],
};

test("assembleRegisterComponent marks the component as global (reusable)", () => {
  const c = assembleRegisterComponent(baseInput, "id-1", 1000);
  assert.equal(c.global, true);
});

test("assembleRegisterComponent trims every field", () => {
  const c = assembleRegisterComponent(
    {
      name: "  comp  ",
      description: "  d  ",
      gitUrl: " u ",
      gitBranch: " b ",
      gitRef: " r ",
      entryPoint: " e ",
      configSchema: [],
      inputPorts: [],
      outputPorts: [],
    },
    "id-2",
    2000,
  );
  assert.equal(c.name, "comp");
  assert.equal(c.description, "d");
  assert.equal(c.gitUrl, "u");
  assert.equal(c.gitBranch, "b");
  assert.equal(c.gitRef, "r");
  assert.equal(c.entryPoint, "e");
});

test("assembleRegisterComponent seeds correct defaults", () => {
  const c = assembleRegisterComponent(baseInput, "id-3", 3000);
  assert.equal(c.status, "draft");
  assert.equal(c.workspaceRoot, "");
  assert.deepEqual(c.inputSchema, {type: "object", properties: {}});
  assert.deepEqual(c.outputSchema, {type: "object", properties: {}});
  assert.deepEqual(c.tags, []);
  assert.deepEqual(c.configSchema, []);
  assert.equal(c.id, "id-3");
  assert.equal(c.createdAtMs, 3000);
  assert.equal(c.updatedAtMs, 3000);
});

test("assembleRegisterComponent carries the declared config_schema through", () => {
  const c = assembleRegisterComponent(
    {
      ...baseInput,
      configSchema: [{key: "text", label: "文本", type: "string", required: true}],
    },
    "id-4",
    4000,
  );
  assert.deepEqual(c.configSchema, [
    {key: "text", label: "文本", type: "string", required: true},
  ]);
});

test("assembleRegisterComponent serializes declared IO ports into schemas", () => {
  const c = assembleRegisterComponent(
    {
      ...baseInput,
      inputPorts: [{name: "src", type: "file"}],
      outputPorts: [{name: "data", type: "file"}],
    },
    "id-5",
    5000,
  );
  assert.deepEqual(c.inputSchema, {
    type: "object",
    properties: {src: {type: "string", format: "file"}},
  });
  assert.deepEqual(c.outputSchema, {
    type: "object",
    properties: {data: {type: "string", format: "file"}},
  });
});

test("canSubmitRegister requires a non-blank name", () => {
  assert.equal(canSubmitRegister({...baseInput, name: ""}), false);
  assert.equal(canSubmitRegister({...baseInput, name: "   "}), false);
  assert.equal(canSubmitRegister({...baseInput, name: "x"}), true);
});

test("assembleUpdateComponent preserves identity and only changes definition fields", () => {
  const base: Component = {
    id: "keep-id",
    name: "old-name",
    description: "old-desc",
    status: "published",
    workspaceRoot: "/some/root",
    gitUrl: "git@old/repo.git",
    gitBranch: "old-branch",
    gitRef: "old-ref",
    entryPoint: "old.py",
    inputSchema: {type: "object", properties: {a: {type: "string", format: "csv"}}},
    outputSchema: {type: "object", properties: {b: {type: "string", format: "csv"}}},
    configSchema: [{key: "old", label: "Old", type: "string", required: false}],
    tags: ["t1"],
    global: true,
    createdAtMs: 111,
    updatedAtMs: 222,
  };
  const updated = assembleUpdateComponent(
    {
      name: "new-name",
      description: "new-desc",
      gitUrl: "git@new/repo.git",
      gitBranch: "new-branch",
      gitRef: "new-ref",
      entryPoint: "new.py",
      configSchema: [],
      inputPorts: [],
      outputPorts: [{name: "out", type: "file"}],
    },
    base,
    999,
  );
  // identity / lifecycle preserved
  assert.equal(updated.id, "keep-id");
  assert.equal(updated.status, "published");
  assert.equal(updated.createdAtMs, 111);
  assert.equal(updated.workspaceRoot, "/some/root");
  assert.deepEqual(updated.tags, ["t1"]);
  assert.equal(updated.global, true);
  // updatedAtMs bumped
  assert.equal(updated.updatedAtMs, 999);
  // definition fields applied
  assert.equal(updated.name, "new-name");
  assert.equal(updated.entryPoint, "new.py");
  assert.deepEqual(updated.outputSchema, {
    type: "object",
    properties: {out: {type: "string", format: "file"}},
  });
});
