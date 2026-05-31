// parser/types.ts

// ========== ID 类型 ==========

/** renderFn 或 View： "文件路径:标识符" */
type NodeId = string;

/** EventBinding： "renderFnId#事件名" */
type EventBindingId = string;

/** Fn / EventHandler： "文件路径:函数名" */
type FnId = string;

/** IPC： "ipc:通道名" */
type IpcId = string;

// ========== Event ==========

interface EventBinding {
    id: EventBindingId;            // "ProductView.tsx:renderProductCard#onEdit"
    bindTo: string;                // 绑定的 DOM 事件属性，如 "onClick"
    handleFnId: FnId;              // 实际处理函数的 ID
}

// ========== Fn ==========

interface FnDetail {
    id: FnId;                      // "ProductView.tsx:handleEdit"
    writes: string[];              // 修改的 state 字段名
    ipcs: IpcId[];                 // 调用的 IPC
    fns: FnId[];                   // 调用的其他函数
}

// ========== RenderFn ==========

interface RenderFnNode {
    id: NodeId;                    // "ProductView.tsx:renderProductCard"
    states: string[];              // 依赖的 state 字段
    props: string[];               // 依赖的 props 字段
    events: EventBinding[];        // 事件绑定列表
    children: RenderFnNode[];      // 子 renderFn
}

// ========== View ==========

interface PropSource {
    type: "state" | "fn";
    viewId: NodeId;
    sourceName: string;
}

interface ViewNode {
    id: NodeId;                    // "ProductView.tsx:ProductView"
    states: string[];              // 声明的 state 变量
    props: Record<string, PropSource>;  // props 的来源映射
    children: RenderFnNode[];      // 顶层 renderFn
}

// ========== Code Graph ==========

interface CodeGraph {
    version: string;               // 时间戳
    views: ViewNode[];
    fnDetails: FnDetail[];         // 所有 EventHandler + 工具函数
}