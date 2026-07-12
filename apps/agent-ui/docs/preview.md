# preview — preview tabs

Module: `src/app/components/PreviewPanel.tsx`, `preview-components.tsx`
Related: [docs/code-mode.md](code-mode.md), [docs/runtime.md](runtime.md)

## 职责

右侧多标签页预览：文件（代码 / CSV / HTML / Markdown + Git diff）或引用（图片 / PDF）。

## 组件

- `PreviewPanelView`：预览面板容器，多标签展示；标签关闭 / 全关。`handleOpenPreviewLink`
  经 `readWorkspaceFile` / `readGitDiff` / `readLocalImagePreview` 取内容。
- `preview-components.tsx` 渲染原语：
  - `CodePreviewView`：代码高亮
  - `CsvDataPreview`：CSV 表格
  - `HtmlRichPreview`：HTML 富文本
  - `MarkdownTablePreview` / `RichMarkdownMessage`：Markdown 渲染
  - `isHtmlFilePath`：路径判定

## 触发

Code 模式消息中的文件引用、用户 @文件、Git diff 等 → 打开预览标签。
