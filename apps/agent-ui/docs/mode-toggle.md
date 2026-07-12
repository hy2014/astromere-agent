# mode-toggle — Code / DAG segmented switch

Module: `src/app/ModeToggle.tsx` + `src/app/ModeToggle.css`
Related: [docs/component-mode.md](component-mode.md), [src/app/App.tsx](../src/app/App.tsx)

## 职责

左上角的分段开关，在 **Code** 与 **DAG** 两种模式间切换。替代原先侧栏底部的
“Components” tab——Component 模式不再作为 tab，而是升格为与 Code 并列的顶层模式。

## 行为

- `AppMode` 类型 = `"code" | "dag"`（由旧 `"component"` 重命名而来）。
- 开关渲染在**两种模式侧栏的左上角第一个元素**：
  - Code 模式：`side-panel` 顶部（`.side-panel-mode`）
  - DAG 模式：`component-mode-sidebar` 顶部（`.component-mode-mode`）
- 默认停在 **Code**；点击右侧切到 DAG。
- 切换时清空预览标签页（`previewTabs` / `activePreviewId`）。
- 持久化：`localStorage["claw:appMode"]`；**旧值 `"component"` 自动映射为 `"dag"`**，
  老用户不会被改名卡住。

## 改造来源

原 `component_mode` 内部“Code”按钮已移除，统一由本开关切回 Code。
