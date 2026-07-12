# error-boundary — 渲染崩溃兜底

Module: `src/app/ErrorBoundary.tsx`

## 作用

- class 组件，捕获任意后代的**渲染期异常**，避免单个组件崩溃把整个 WebView 刷白。
- 崩溃时渲染错误卡片（错误消息 + Reload 按钮），并把错误打到 `console.error`。
- 当前在 `App.tsx` 的 dag 分支包住 `ComponentModeView`。

## 何时用

任何新加的、可能抛渲染错误的顶层区域都建议用 `<ErrorBoundary>` 包一层，作为最后
的安全网。它不替代 try/catch（异步错误仍由各调用点的 catch 处理）。
