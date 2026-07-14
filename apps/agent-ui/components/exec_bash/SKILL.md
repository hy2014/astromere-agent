# 执行bash脚本 (exec_bash)

在 worker 机器上执行一个 bash 脚本，并把执行结果作为 `status` 端口输出。

## 注册配置（agent-ui 组件定义）

- **gitUrl**: `git@github.com:hy2014/astromere-agent.git`
- **gitBranch**: `dev`
- **entryPoint**: `apps/agent-ui/components/exec_bash/run.py`
- **global**: `true`（注册组件，可跨 DAG 复用）
- **输入端口**: 0 个
- **输出端口**: `exec_status`（type=status）
- **configSchema**:
  - `script_path`（必填，type=path）：worker 机器上可访问的 bash 脚本绝对路径
  - `args`（可选，type=string）：传给脚本的额外参数

## 运行契约

- 引擎写死 `[python, entry_point]`，本组件是 Python 壳，内部以
  `bash -e -u -o pipefail <script_path> [args...]` 调起目标脚本。
- 退出码即成败：非 0 → 节点失败、下游被 skip；0 → 节点成功。
- 脚本无需自带 `set -e`，包装层已保证“任一步失败即整体失败”（无 set -e 仅告警）。
- 输出写入 `AGENT_UI_OUTPUT_PATH`：`{"exec_status": {"status": "ok" | "error"}}`。

## 用法提示

- 该节点为**源节点**（无输入端口），运行时其 `config.params` 直接作为
  输入 JSON 下发，故组件读取 `data["script_path"]` / `data["args"]`。
  不要给它连入 status 边，否则 config 参数不会被下发。
- `script_path` 指向的文件必须存在于 **worker 机器**上（与是否 git 仓库无关）。
