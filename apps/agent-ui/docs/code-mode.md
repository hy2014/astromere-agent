# code-mode — Agent REPL conversation experience

Module: `src/app/components/SessionDialog.tsx`, `messages-stream.tsx`, `PromptInputArea.tsx`
and supporting cards.
Related: [docs/app-shell.md](app-shell.md), [docs/streaming.md](streaming.md), [docs/runtime.md](runtime.md)

## 职责

Code 模式的核心对话界面：用户与 agent REPL 进程对话、查看流式回复、处理权限请求、预览文件引用。这是本 app 的主体交互，DAG 模式是后来叠加在其上的。

## 组件

- `SessionDialogView`：REPL 容器，编排 `MessagesStreamView` + `PromptInputAreaView` + `DetailPanel`（预览/过程详情）；通过 `WriteState` 单例桥接子组件回调（turn 状态、过程事件）；处理提交 prompt、中断、fork、权限响应入口。
- `MessagesStreamView`：聊天消息流。从 `loadTypedRuntimeSession` 加载历史（`runtimeSessionToArtifacts` → `StreamItem[]`），实时消费 `session-items` 事件渲染流式文本，turn 完成时重载；渲染 user/assistant/system/tool/artifact 各类卡片；承载 Usage 浮层入口。
- `PromptInputAreaView`：输入框 + 发送区。组合 `usePromptInput`；渲染权限请求卡（`PermissionRequestView` / `AskQuestionCardView`）、文件引用托盘、@提及与 `/` 斜杠命令菜单、权限模式与模型选择、上下文用量 chip、发送/停止按钮。
- `usePromptInput`：输入交互 hook。管理 @文件引用、`/skill`、`/command` 菜单、IME 合成防护、文件搜索、键盘导航与提交；向后端拉取 capability（skills/commands）。
- `AssistantMessageCard` / `UserMessageCard`：助手/用户消息卡片，富文本 + 图片 + 链接 + 用量浮层 + Fork 按钮。
- `AskQuestionCardView`：AskUserQuestion 多选项问答表单，确认时回传 answers。
- `PermissionRequestView`：工具权限 allow/deny 卡。
- `FileReferenceTrayView`：输入区 @文件引用托盘，可移除/打开预览。
- `image-reference-view`：消息内图片缩略 + 预览面板（远程/本地元数据读取）。
- `assistant-usage-mini-overlay`：单条助手消息的 `ModelCallUsage` 聚合浮层。

## 数据流

输入 → `SessionDialogView.handleSubmitPromptAction` → `ensureAgentReplProcess` + `sendAgentReplInput`
（经 `runtime` → `tauri` → Rust）→ Rust 事件流经 [streaming](streaming.md) 层 →
`MessagesStreamView` 消费 `session-items`，`PromptInputArea` 消费 `control-request`。
