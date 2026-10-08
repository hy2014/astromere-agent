import type {Component, DagNode} from "../../types";

// 节点剪贴板：右键节点「复制」写入，空白处右键「粘贴」读出。
//
// 复制的是「一个节点」：组件定义快照 + 节点实例配置（label/params）。
// 不复制边（单边没有对端可接）和任何执行状态/产物。
// 模块级单例，切换 DAG 不丢（同一次应用会话内可跨 DAG 粘贴）。
export type NodeClipboardEntry = {
  // 组件定义快照：内联组件粘贴时要据此克隆一份新组件行；
  // 也作为源组件行已被删除时的判断依据。
  component: Component;
  label: string;
  params: Record<string, unknown>;
};

type PastePosition = {x: number; y: number};

export type PastedNode = {
  dagNode: DagNode;
  // 内联组件（global=false）是节点私有的：粘贴时克隆出一份新组件定义，
  // 两个节点的定义互不影响（与拖入即建行、删节点即删行的语义一致）。
  // 已注册组件直接复用同一个 componentId，这里为 null。
  newComponent: Component | null;
};

export type PasteError = {error: string};

export type BuildPastedNodeInput = {
  entry: NodeClipboardEntry;
  dagId: string;
  position: PastePosition;
  newNodeId: string;
  newComponentId: string;
  now: number;
  // 目标环境里源组件行是否还在。已注册组件若被删除，禁止粘贴
  // （内联组件不靠它：定义从快照克隆）。
  registeredExists: boolean;
  // 目标环境已有的全部组件名。后端对组件名做全局唯一校验，
  // 克隆内联组件时据此给「副本」名递增去重（副本 / 副本 2 / 副本 3…）。
  existingNames: string[];
};

function cloneJson<T>(value: T): T {
  // 剪贴板内容都是表单/定义类纯 JSON 数据，用 JSON 做深拷贝最稳。
  return JSON.parse(JSON.stringify(value)) as T;
}

// 生成不与 existingNames 冲突的副本名：优先「原名 副本」，
// 被占用则递增「原名 副本 2 / 3 …」（与文件管理器副本命名习惯一致）。
export function uniqueCopyName(originalName: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  const base = `${originalName} 副本`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function buildPastedNode(input: BuildPastedNodeInput): PastedNode | PasteError {
  const {entry, dagId, position, newNodeId, newComponentId, now, registeredExists, existingNames} =
    input;
  const {component, label, params} = entry;

  let componentId = component.id;
  let newComponent: Component | null = null;
  if (component.global) {
    if (!registeredExists) {
      return {error: "源组件已被删除，无法粘贴（已注册组件按 ID 引用）"};
    }
  } else {
    newComponent = {
      ...cloneJson(component),
      id: newComponentId,
      name: uniqueCopyName(component.name, existingNames),
      global: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    componentId = newComponentId;
  }

  const dagNode: DagNode = {
    id: newNodeId,
    dagId,
    componentId,
    label,
    position: {x: position.x, y: position.y},
    // 深拷贝：粘贴出的节点和剪贴板、源节点之间不共享 params 对象。
    config: {params: cloneJson(params)},
  };
  return {dagNode, newComponent};
}

export function isPasteError(result: PastedNode | PasteError): result is PasteError {
  return "error" in result;
}

// ── 模块级剪贴板单例 ──────────────────────────────────────────────
let clipboard: NodeClipboardEntry | null = null;

export function copyNodeToClipboard(entry: NodeClipboardEntry): void {
  // 存入即深拷贝：复制后再编辑源节点，不会污染剪贴板。
  clipboard = cloneJson(entry);
}

export function readNodeClipboard(): NodeClipboardEntry | null {
  // 读出也深拷贝：粘贴方拿到的对象与剪贴板内部隔离。
  return clipboard ? cloneJson(clipboard) : null;
}

export function hasClipboardNode(): boolean {
  return clipboard !== null;
}
