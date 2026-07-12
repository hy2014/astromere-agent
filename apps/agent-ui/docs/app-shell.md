# app-shell — application shell, navigation & session state

Module: `src/app/App.tsx`, `src/app/components/workspace-tree.tsx`, `SessionList.tsx`,
`src/app/WorktreePanel.tsx`, `src/app/session.ts`
Related: [docs/code-mode.md](code-mode.md), [docs/mode-toggle.md](mode-toggle.md), [docs/runtime.md](runtime.md)

## 职责

整个 Code 模式的中枢：定义 top-level UI 区域、持有全部 UI 状态、切换视图、管理项目与会话。

## 布局与视图切换

- 侧栏 `side-panel`：ModeToggle + WorkspaceTreeView + Skills/MCP/Terminal/Settings 导航按钮。
- 主区按 `activeView` 切换：
  - `workspace`（默认）→ `SessionDialogView`（REPL 主界面）
  - `terminal` → 本地 `TerminalView` / 远程 `RemoteTerminalPlaceholder`
  - `skills` → `SkillsView`
  - `mcp` → `McpServersView`
  - `settings` → `SettingsView`

## 状态（全部以 App.tsx 的 useState 为事实源）

`projects`、`previewTabs`、`activeSessionId`、`appMode`、`turnInfo`、`permissionState`、
`hiddenSessions` 等。无独立 store 模块（DAG 模式的 store 在 `src/stores/`，见
[component-mode](component-mode.md)）。

## 会话状态助手 `session.ts`

- `createPendingSession()`、`sessionsFromRuntimeSummaries()`、`dedupeSessions()`：把运行时
  session 摘要转成 UI 的 `ProjectSession` 列表（无会话时给一个 pending）。
- 隐藏会话：`hiddenSessions` 存于 `localStorage["agent-ui.hiddenSessions.v1"]`；
  `loadHiddenSessions` / `isHiddenSession` / `uniqueHiddenSessions` 管理（Settings 的
  Sessions 段可恢复）。
- `sessionKey(root, sessionId)`、`projectIdFromRoot(root)`、`isNewSessionId()`：key 与判断工具。
- `firstUserTitleFromStream()`：用首条 user 消息作为会话标题。

## 侧栏组件

- `WorkspaceTreeView`：品牌区 + 项目增删（远程路径输入弹窗 + 目录补全）+ 折叠树 +
  委托 `SessionListView` + 项目右键删除菜单。
- `SessionListView`：会话列表（含运行状态点）、右键菜单（Fork / 删除 / 隐藏）、新建会话按钮。
- `WorktreePanel`：Worktree 面板（**桩**——后端 `listWorktrees` 未实现，返回空），仅占位。

## 注意

`src/app/session-store.ts` 是**死代码**（全 `src/` 无引用），请勿使用；会话状态逻辑在
`App.tsx` + `session.ts`。
