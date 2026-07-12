# streaming — REPL event pipeline

Module: `src/hooks/stream-event-bus.ts`, `src/app/stream-processor.ts`, `src/app/debug-utils.ts`,
`src/app/stream-handlers/*`
Related: [docs/code-mode.md](code-mode.md), [docs/runtime.md](runtime.md)

## 职责

整个 Code 模式流式更新的核心：把 Rust 推来的 `AgentReplStreamEvent` 归约为命名数据流，
广播给视图层。

## stream-event-bus（全局广播层）

- 纯事件广播，应用只调用一次 `listenAgentReplEvents`。
- `setEventHandle(name, handle)`：**1 name → 1 handler**（重复注册 warn + 覆盖）；
  handler 签名 `(event, prevData) => unknown | null`。
- `addCallback(name, cb)`：**1 name → n callbacks**，返回 unsubscribe。
- `data[name][sessionId]`：全局 store；`getSessionData(sessionId, key)` 读取。
- `startStreamEventListener()`：幂等，启动底层监听；对每个事件遍历已注册 handler，写入
  store 并通知 callbacks。

## stream-processor（归并引擎）

把流式事件转成 UI items：`resolveRuntimeBundleEvent`、`applyRuntimeDebugEventToBundle`、
`streamEventToItems`、`upsertCurrentTurnProgressMessage`、`completeCurrentTurnAssistantMessage`、
`mergeProgressText`、`collapseAssistantTurns`。管理 “bundle”（一次 model call = 一条助手消息）
的起止与文本拼接。

## debug-utils

`runtimeSessionToArtifacts`：把 `RuntimeSessionDetail`（JSONL）转成 `StreamItem[]` + 每消息的
`AssistantMessageDebugBundle`；`assistantTurnTimeline` 构建过程时间线。

## stream-handlers（事件契约）

每个 handler 签名 `(event, prevData) => Data | null`，写入 `data[name][sessionId]`：

- `control-request`：解析 permission/control 请求为 `PendingPermission`（turn 完成时清除）。
- `turn-status`：turn 状态机（permission → `ctrl_block`，完成/错误/中断 → `idle`）。
- `session-metadata`：提取 `processStatus` / `processPid`（侧栏状态点）。
- `session-items`：提取助手流式文本 `runningResponse`。
- `message-detail`：每 assistant 事件 → `DebugStreamEvent`（过程详情时间线）。
- `context-usage`：上下文用量刷新信号（`refresh` 时重新拉 `getAgentContextUsage`）。
- `compacting`：auto-compact 是否进行中的布尔信号。
- `usage-cost`：处理 `session-usage` 事件（token/成本快照）。

`App.tsx` 在 `useEffect` 注册这些 handle；视图层用 `addCallback` 消费。
