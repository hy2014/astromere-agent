# runtime — local/remote runtime abstraction

Module: `src/runtime/index.ts`, `local.ts`, `remote.ts`, `profiles.ts`
Related: [docs/streaming.md](streaming.md), [docs/settings.md](settings.md)

## 职责

把 UI 与“agent REPL 运行在哪里”解耦。统一 `AgentRuntime` 接口，根据激活的远程 profile
在本地（Tauri `invoke`）与远程（HTTP/WebSocket）之间路由。切换运行时，其余 UI 代码无感知。

## 设计

- `AgentRuntime = typeof localRuntime`（`local.ts` = `export * from "../tauri"`）。
- `index.ts` 把所有 runtime 函数实现为 `(...args) => getCurrentRuntime().<fn>(...args)` 的转发器。
- `resolveInitialRuntime()`：读 `getActiveRemoteProfileId()`，有激活 profile 且存在则
  `createRemoteRuntime(profile)`，否则 `localRuntime`。
- 切换：`useLocalRuntime()`（并 `sendClientExit` 旧远程）、`useRemoteRuntime(profile)`
  （创建远程运行时）。`setCurrentRuntimeForDev` 供调试。
- `getCurrentRuntime()`：返回当前运行时。

## 远程 profile 持久化 `profiles.ts`

- `localStorage` key：`agent-ui.remoteProfiles.v1`、`activeRemoteProfileId.v1`。
- `loadRemoteProfiles` / `saveRemoteProfiles` / `upsertRemoteProfile` / `deleteRemoteProfile` /
  `getActiveRemoteProfileId` / `setActiveRemoteProfileId` / `createRemoteProfileInput`。

## 远程实现 `remote.ts`

`createRemoteRuntime`：把 IPC 调用转为对远程代理的 HTTP/WebSocket（如 `/agent/ensure`、
`/agent/fork`、`/events` SSE、`/pty` WebSocket）。`testRemoteHealth` 健康检查。
`sendClientExit` 退出通知。
