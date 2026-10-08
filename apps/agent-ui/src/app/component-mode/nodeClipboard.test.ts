import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import type {Component} from "../../types";
import {
  buildPastedNode,
  copyNodeToClipboard,
  hasClipboardNode,
  isPasteError,
  readNodeClipboard,
  uniqueCopyName,
} from "./nodeClipboard";

function makeComponent(overrides: Partial<Component> = {}): Component {
  return {
    id: "comp-1",
    name: "我的组件",
    description: "",
    status: "draft",
    workspaceRoot: "",
    gitUrl: "git@example.com:repo.git",
    gitBranch: "master",
    gitRef: "",
    entryPoint: "run.py",
    inputSchema: {type: "object", properties: {in1: {type: "string"}}},
    outputSchema: {type: "object", properties: {out1: {type: "status"}}},
    configSchema: [],
    tags: [],
    global: false,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

const baseInput = {
  dagId: "dag-B",
  position: {x: 120, y: 240},
  newNodeId: "node-new",
  newComponentId: "comp-new",
  now: 9999,
  existingNames: [] as string[],
};

describe("buildPastedNode — 已注册组件", () => {
  const registered = makeComponent({global: true, id: "comp-reg"});
  const entry = {
    component: registered,
    label: "实例别名",
    params: {args: "--k v", nested: {a: 1}, flag: true},
  };

  it("复用同一个 componentId，不新建组件行", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: true});
    assert.ok(!isPasteError(r));
    assert.equal(r.newComponent, null);
    assert.equal(r.dagNode.componentId, "comp-reg");
  });

  it("生成新节点 id、落到目标 dagId/位置，label 原样复制", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: true});
    assert.ok(!isPasteError(r));
    assert.equal(r.dagNode.id, "node-new");
    assert.equal(r.dagNode.dagId, "dag-B");
    assert.deepEqual(r.dagNode.position, {x: 120, y: 240});
    assert.equal(r.dagNode.label, "实例别名");
  });

  it("params 深拷贝，与来源互不影响", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: true});
    assert.ok(!isPasteError(r));
    assert.deepEqual(r.dagNode.config.params, entry.params);
    const pasted = r.dagNode.config.params as {nested: {a: number}};
    pasted.nested.a = 999;
    assert.equal((entry.params.nested as {a: number}).a, 1);
  });

  it("源组件行已被删除时拒绝粘贴并给中文错误", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: false});
    assert.ok(isPasteError(r));
    assert.match(r.error, /已被删除/);
  });
});

describe("buildPastedNode — 内联组件", () => {
  const inline = makeComponent({global: false, id: "comp-inline", name: "内联组件-abc"});
  const entry = {component: inline, label: "", params: {}};

  it("克隆一份新组件定义：新 id、副本命名、保持私有", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: false});
    assert.ok(!isPasteError(r));
    assert.ok(r.newComponent);
    assert.equal(r.newComponent.id, "comp-new");
    assert.equal(r.newComponent.name, "内联组件-abc 副本");
    assert.equal(r.newComponent.global, false);
    assert.equal(r.dagNode.componentId, "comp-new");
  });

  it("克隆体保留定义内容（git/端口），但不与源对象共享引用", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: false});
    assert.ok(!isPasteError(r));
    assert.equal(r.newComponent?.gitUrl, inline.gitUrl);
    assert.deepEqual(r.newComponent?.outputSchema, inline.outputSchema);
    r.newComponent!.outputSchema.properties!.extra = {type: "string"};
    assert.equal(inline.outputSchema.properties!.extra, undefined);
  });

  it("克隆体刷新时间戳", () => {
    const r = buildPastedNode({...baseInput, entry, registeredExists: false});
    assert.ok(!isPasteError(r));
    assert.equal(r.newComponent?.createdAtMs, 9999);
    assert.equal(r.newComponent?.updatedAtMs, 9999);
  });

  it("组件名按已有名称递增去重，避开后端全局唯一名校验", () => {
    const pasteName = (existingNames: string[]) => {
      const r = buildPastedNode({...baseInput, entry, registeredExists: false, existingNames});
      assert.ok(!isPasteError(r));
      return r.newComponent!.name;
    };
    assert.equal(pasteName([]), "内联组件-abc 副本");
    assert.equal(pasteName(["内联组件-abc 副本"]), "内联组件-abc 副本 2");
    assert.equal(
      pasteName(["内联组件-abc 副本", "内联组件-abc 副本 2"]),
      "内联组件-abc 副本 3",
    );
  });
});

describe("uniqueCopyName", () => {
  it("首次用「原名 副本」，占用后递增", () => {
    assert.equal(uniqueCopyName("X", []), "X 副本");
    assert.equal(uniqueCopyName("X", ["X 副本"]), "X 副本 2");
    assert.equal(uniqueCopyName("X", ["X 副本", "X 副本 2"]), "X 副本 3");
  });

  it("只在同名时避让，不受其他组件名影响", () => {
    assert.equal(uniqueCopyName("X", ["Y 副本", "Z"]), "X 副本");
  });
});

describe("剪贴板单例", () => {
  beforeEach(() => {
    copyNodeToClipboard({
      component: makeComponent(),
      label: "x",
      params: {a: 1},
    });
  });

  it("复制后可读、空态判断正确", () => {
    assert.equal(hasClipboardNode(), true);
    const e = readNodeClipboard();
    assert.equal(e?.label, "x");
  });

  it("存入即隔离：复制后改动源对象不影响剪贴板", () => {
    const source = {component: makeComponent(), label: "y", params: {k: "v"}};
    copyNodeToClipboard(source);
    source.label = "changed";
    (source.params as Record<string, unknown>).k = "changed";
    assert.equal(readNodeClipboard()?.label, "y");
    assert.equal(readNodeClipboard()?.params.k, "v");
  });

  it("读出即隔离：改读取结果不污染后续读取", () => {
    const first = readNodeClipboard()!;
    first.label = "changed";
    assert.equal(readNodeClipboard()?.label, "x");
  });
});
