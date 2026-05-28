# Skill 系统设计（开发中）

> **状态：开发中 / 实验性** — 本文档描述的系统正在积极设计和迭代中。接口、约定和行为可能随时变更。

---

## 动机

AI coding agent 擅长生成一次性脚本，但这些输出通常在对话结束后就被丢弃。Skill 系统的目标是：

1. **封装可复用的分析逻辑**，让用户和 agent 无需样板代码即可调用
2. **捕获会话级别的 artifact** — 图表、报告、HTML、数据文件 — 可在后续对话中引用
3. **对用户和模型隐藏实现细节**，保持接口简洁

愿景是将复杂的多轮探索工作流表达为：

```text
用户意图 + 数据引用 + skill 调用
  => 可复用分析
  => 持久化 artifact
  => 后续进一步优化
```

---

## 核心概念

### Skill

Skill 是 `.claude/skills/` 下的一个目录，包含：

- `SKILL.md` — 元数据和面向模型的调用说明
- `scripts/` — 可执行实现（Python、shell 等）

模型应该只通过 `agent-ui-skill-run` 看到高层调用，不需要了解内部脚本路径或输出目录管理。

### Artifact

Artifact 是 skill 执行生成的输出文件，存储在会话隔离的目录中：

```text
<workspace>/.agent-ui/<session-id>/
```

Artifact 通过 `manifest.json` 记录，附带类型分类（如 `rich_display/html`），可以：
- 在 Desktop UI 中预览
- 在后续对话中通过文件路径引用
- 按会话浏览和列表查看

### agent-ui-skill-run

连接 agent 和 skill 的包装器：

```bash
$HOME/.agent-ui/bin/agent-ui-skill-run \
  --skill <skill-name> \
  --method <method> \
  --output-dir "$AGENT_UI_OUTPUT_DIR" \
  -- <implementation command>
```

它解析 skill 实现、执行脚本、捕获输出、写入 `manifest.json`，并输出结构化结果供模型总结。

---

## 示例流程：K-line Chart

### 用户输入

```
/kline-chart @samples/kline_sample.csv 生成交互式图表
```

### 执行过程

1. agent 识别 `/kline-chart` slash command
2. 读取 `SKILL.md` 获取调用说明
3. 执行 `agent-ui-skill-run`，指向 skill 的 `scripts/run.py`
4. 脚本读取 CSV，生成 Plotly HTML 图表，写入输出目录
5. `agent-ui-skill-run` 在 `manifest.json` 中记录输出
6. agent 总结结果
7. Desktop UI 显示生成 artifact 的可点击链接

### 输出

```text
.agent-ui/<session-id>/kline-chart.xxx.html
```

artifact 可以在 preview 面板中打开，并在后续对话中引用：

```
/kline-chart @samples/kline_sample.csv 生成图表，并加上 MA5 和 MA20 线
```

---

## Skill 设计原则

1. **隐藏 runtime 细节** — 面向模型的指令不应涉及输出目录、环境变量或内部脚本路径
2. **一个 skill 只做一件事** — 如生成图表、转换数据、生成报告
3. **结构化输出** — 使用 `agent-ui-skill-run` 自动跟踪 artifact
4. **尽可能幂等** — 相同输入产生相同输出，使 skill 可预测、可调试

---

## 当前限制

- 有限的 artifact 类型分类（主要是 `rich_display/html`）
- 不支持 skill 间的依赖管理
- 不支持 skill 链式调用 / 流水线
- 没有版本控制或缓存
- 错误处理较为基础

这些都是正在探索的方向。

---

## 未来方向

- **Skill 组合** — 链式调用：转换数据 → 生成图表 → 生成报告
- **参数化 Skill** — 除文件路径外的结构化输入
- **Skill 市场 / 发现** — 从注册中心浏览和安装 skill
- **输出缓存** — 输入未变化时跳过重复执行
- **非 HTML artifact** — 原生数据查看器、图片预览、PDF 渲染
