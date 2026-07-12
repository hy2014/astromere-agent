# terminal — OS terminal

Module: `src/app/Terminal.tsx`, `RemoteTerminalPlaceholder.tsx`
Related: [docs/app-shell.md](app-shell.md)

## 职责

提供本地 OS 终端（xterm），以及远程模式下的占位提示。

## 实现

- `TerminalView`（`Terminal.tsx`）：**被 `App.tsx` 使用**。基于 xterm + Tauri
  `terminal_spawn` / `terminal_write` / `terminal_kill` 与 `terminal:data:<id>` 事件，多标签。
- `RemoteTerminalPlaceholder`：**被 App 使用**。远程运行时暂不支持交互终端，显示占位提示。

## 注意（遗留实现）

仓库另有两套**未被引用**的终端实现（属遗留 / 替代）：

- `TerminalPanel.tsx` + `TerminalBackend.ts` + `TerminalRemote.tsx`：基于
  `__TAURI_INTERNALS__.invoke("pty_terminal_*")` 与 WebSocket 的另一套 xterm。

全 `src/` 无任何文件 import 它们——死代码，可后续清理。
