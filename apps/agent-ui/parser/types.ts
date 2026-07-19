// parser/types.ts
//
// Core type definitions - describe the full structure graph of a React View component
// Reference mcp-test.tsx coding style
//
// renderFn signature convention:
//   function renderXxx(
//     state: { ...fields },       // param[0]: state fields passed from the View
//     props: { ...fields },       // param[1]: props passed from the parent component
//     events: { ...handlers },    // param[2]: event handlers (file-level functions)
//     ext?: { ...fields },        // param[3]: extra data / context
//     memo?: { ...fields },       // param[4]: derived values
//   )
//
// Invocation:
//   render({ state: {...}, props: {...}, fn: renderXxx, events: {...}, exts?: {...}, memo?: {...} })

// ========== ID types ==========

/** renderFn or View: "filePath:identifier" */
export type NodeId = string;

/** EventBinding: "renderFnId#eventName" */
export type EventBindingId = string;

/** Fn / EventHandler: "filePath:functionName" */
export type FnId = string;

/** IPC: "ipc:channelName" */
export type IpcId = string;

// ========== State ==========

/** State field information */
export interface StateInfo {
    name: string;                 // state field name, e.g. "rows"
    setter: string;               // setter name, e.g. "setRows" / "WriteState.setRows"
    initialValue: string;         // initial value
}

/** Props field information */
export interface PropInfo {
    name: string;
    type: string;
}

// ========== Event ==========

export interface EventBinding {
    id: EventBindingId;           // "ProductView.tsx:renderProductCard#onEdit"
    bindTo: string;               // bound DOM event attribute, e.g. "onClick"
    handleFnId: FnId;             // actual handler function ID
}

// ========== Fn ==========

export interface FnDetail {
    id: FnId;                     // "mcp-test.tsx:handleAddServer"
    writes: string[];             // modified state field names, e.g. ["rows"]
    ipcs: IpcId[];                // called IPC, e.g. ["ipc:loadMcpSettings"]
    fns: string[];                // other called function names, e.g. ["mcpSettingsFromDraftRows"]
    views: NodeId[];              // ViewNode IDs connected via renderView()
}

// ========== RenderFn ==========

export interface RenderFnNode {
    id: NodeId;                   // "mcp-test.tsx:renderMcpServerTable"
    fnId: FnId;                   // corresponding FnDetail ID, including its internal function-call relationships
    states: string[];             // depended-on state fields (memo already expanded)
    props: string[];              // depended-on props fields
    exts: string[];               // depended-on ext fields (4th render param)
    events: EventBinding[];       // event binding list
    children: RenderFnNode[];     // child renderFn
    renderViews: NodeId[];        // ViewNode IDs connected via renderView()
}

// ========== View ==========

export interface PropSource {
    type: "state" | "fn";
    viewId: NodeId;
    sourceName: string;
}

export interface ViewNode {
    id: NodeId;                   // "mcp-test.tsx:McpServersView"
    states: string[];             // declared state variables
    props: Record<string, PropSource>;  // props source mapping
    useEffect: FnDetail | null;   // handlers called in useEffect, as a complete FnDetail
    children: RenderFnNode[];     // top-level renderFn
}

// ========== Code Graph ==========

export interface CodeGraph {
    version: string;              // timestamp
    views: ViewNode[];
    fns: FnDetail[];             // all EventHandlers + utility functions
}

// ========== Internal helper types (not exported) ==========

/** Classification of calls inside a function */
export interface ClassifiedCall {
    type: "write" | "ipc" | "call";
    text: string;                 // original call text
    target?: string;              // target state name of the write
}
