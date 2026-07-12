# backend-utils — shared helpers

Module: `src-tauri/src/utils.rs`
Related: [docs/sqlite.md](sqlite.md), [docs/component-session.md](component-session.md)

## 职责

跨模块复用的纯函数与小工具。

## 关键函数

- `ui_config_dir()`：返回 agent-ui 配置目录（SQLite DB、dag-executions 落于此）。
- `canonical_workspace_root(root)`：规范化 workspace 路径（用于 session 目录推导）。
- `claude_project_sessions_dir(root)`：返回 `~/.claude/projects/<workspace-root-sanitized>/`，
  `component_session` 据此算 session 路径。
- `generate_agent_ui_session_id()`：生成 component session id（`component_session.rs` 复用）。
- `now_millis()`：当前毫秒时间戳（多处写入 `created_at_ms` / `updated_at_ms`）。
- 其他：错误处理辅助、路径 / 文件小工具。

## 注意

这些函数多为 `pub`，被 `sqlite` / `components` / `dag` / `executor` / `scheduler` /
`component_session` 广泛调用；改动需留意全局影响。
