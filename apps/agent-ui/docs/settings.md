# settings — settings, models, remote, skills, MCP, usage

Module: `src/app/components/settings-view.tsx`, `models-settings-panel.tsx`,
`remote-settings-panel.tsx`, `skills-view.tsx`, `mcp-servers-view.tsx`, `usage-dashboard.tsx`,
`assistant-usage-mini-overlay.tsx`, `src/app/usage-cost.ts`
Related: [docs/runtime.md](runtime.md)

## 设置主视图 `SettingsView`

顶部栏 + 侧栏（Models / Remote / Sessions 分段）+ 内容区。Sessions 段展示隐藏会话并可恢复。

## 各面板

- `ModelsSettingsPanelView`：加载 / 保存 / 测试 `ModelSettings`（含 `loadDeepseekPricing` 定价）。
- `RemoteSettingsPanelView`：远程运行时 profile 增删改、激活 / 切换本地远程、健康检查
  （接 `runtime.useRemoteRuntime` / `testRemoteHealth`）。
- `SkillsView`：列出 / 搜索项目与用户 skills（`listSkills`）。
- `McpServersView`：加载 / 编辑 / 保存 `McpSettings`（`loadMcpSettings` / `saveMcpSettings`）。
- `SessionUsageDashboardView`：聚合各 bundle 的 token / 成本 / 命中率。
- `AssistantUsageMiniOverlayView`：单条助手消息的 `ModelCallUsage` 聚合浮层。

## 用量计算库 `usage-cost.ts`

纯函数：从 `ModelCallUsage` / bundle 快照聚合
`usageTotalsFromUsage`（token）、`calculateBundleUsageCostFromDeepSeekPricing`（DeepSeek 定价成本）、
`bundleUsageHitRate`（命中率）、`contextUsageFromBundleSnapshot`（上下文用量）、
`sessionUsageTotals` / `sessionUsageCostAmount` 等。
