// parser/types.ts
//
// 核心类型定义 — 描述一个 React View 组件的完整结构图
// 参考 mcp-test.tsx 的 coding style
//
// renderFn 签名约定:
//   function renderXxx(
//     state: { ...fields },       // param[0]: 从 View 传入的状态字段
//     props: { ...fields },       // param[1]: 从父组件传入的 props
//     events: { ...handlers },    // param[2]: 事件处理函数（文件级函数）
//     ext?: { ...fields },        // param[3]: 额外数据 / 上下文
//     memo?: { ...fields },       // param[4]: 派生值
//   )
//
// 调用方式:
//   render({ state: {...}, props: {...}, fn: renderXxx, events: {...}, exts?: {...}, memo?: {...} })

// ========== ID 类型 ==========

/** renderFn 或 View："文件路径:标识符" */
export type NodeId = string;

/** EventBinding："renderFnId#事件名" */
export type EventBindingId = string;

/** Fn / EventHandler："文件路径:函数名" */
export type FnId = string;

/** IPC："ipc:通道名" */
export type IpcId = string;

// ========== State ==========

/** 状态字段信息 */
export interface StateInfo {
    name: string;                 // 状态字段名，如 "rows"
    setter: string;               // setter 名称，如 "setRows" / "WriteState.setRows"
    initialValue: string;         // 初始值
}

/** Props 字段信息 */
export interface PropInfo {
    name: string;
    type: string;
}

// ========== Event ==========

export interface EventBinding {
    id: EventBindingId;           // "ProductView.tsx:renderProductCard#onEdit"
    bindTo: string;               // 绑定的 DOM 事件属性，如 "onClick"
    handleFnId: FnId;             // 实际处理函数的 ID
}

// ========== Fn ==========

export interface FnDetail {
    id: FnId;                     // "mcp-test.tsx:handleAddServer"
    writes: string[];             // 修改的状态字段名，如 ["rows"]
    ipcs: IpcId[];                // 调用的 IPC，如 ["ipc:loadMcpSettings"]
    fns: string[];                // 调用的其他函数名，如 ["mcpSettingsFromDraftRows"]
}

// ========== RenderFn ==========

export interface RenderFnNode {
    id: NodeId;                   // "mcp-test.tsx:renderMcpServerTable"
    states: string[];             // 依赖的 state 字段（已包含 memo 展开）
    props: string[];              // 依赖的 props 字段
    exts: string[];               // 依赖的 ext 字段（4th render param）
    events: EventBinding[];       // 事件绑定列表
    children: RenderFnNode[];     // 子 renderFn
}

// ========== View ==========

export interface PropSource {
    type: "state" | "fn";
    viewId: NodeId;
    sourceName: string;
}

export interface ViewNode {
    id: NodeId;                   // "mcp-test.tsx:McpServersView"
    states: string[];             // 声明的 state 变量
    props: Record<string, PropSource>;  // props 的来源映射
    useEffect: FnDetail | null;   // useEffect 中调用的 handler，完整的 FnDetail
    children: RenderFnNode[];     // 顶层 renderFn
}

// ========== Code Graph ==========

export interface CodeGraph {
    version: string;              // 时间戳
    views: ViewNode[];
    fns: FnDetail[];             // 所有 EventHandler + 工具函数
}

// ========== 内部辅助类型（不导出） ==========

/** 函数内部 call 分类 */
export interface ClassifiedCall {
    type: "write" | "ipc" | "call";
    text: string;                 // 调用的原文
    target?: string;              // write 的目标 state 名
}
