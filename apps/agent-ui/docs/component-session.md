# component-session — Component ↔ Code-mode session link

Module: `src-tauri/src/component_session.rs`
Related: [docs/components.md](components.md)

## 职责

管理 Component 与 Code 模式（Agent REPL）会话的关联。一个 Component 可挂载多个 session。
从 Component 模式点击节点 → 看到 session 列表 → 打开即进入 Code 模式，工作区 = 该组件的
`workspace_root`。

## 会话文件路径

`compute_session_path(workspace_root, session_id)` 计算：

```
~/.claude/projects/<workspace-root-sanitized>/<session-id>.jsonl
```

- `<workspace-root-sanitized>` 由 `canonical_workspace_root()` 规范化后生成。
- 多个共享同一 `workspace_root` 的 Component，其 session 文件落在同一 `.claude/projects/...`
  目录下（与 Code 模式项目的 session 自然共处）。

## 命令（Tauri commands）

| 命令 | 说明 |
|---|---|
| `create_component_session(component_id, title?)` | 新建 session，`session_id` 由 `generate_agent_ui_session_id()` 生成，`session_path` 自动计算 |
| `list_component_sessions(component_id)` | 列出组件的 session（按 `updated_at_ms` 倒序） |
| `update_component_session_title(session_id, title)` | 改标题 |
| `delete_component_session(session_id)` | 删除关联（不删磁盘上的 `.jsonl`） |

## 注意

删除 `component_sessions` 行**不会删除**磁盘上的 `.jsonl` 会话文件，仅解除关联。
