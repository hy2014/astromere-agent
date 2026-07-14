# 执行bash脚本组件 (exec_bash)

在 worker 机器上执行一个 bash 脚本。

## 配置

| 参数        | 必填 | 类型   | 说明                                          |
| ----------- | ---- | ------ | --------------------------------------------- |
| script_path | 是   | path   | worker 机器上可访问的 bash 脚本绝对路径        |
| args        | 否   | string | 传给脚本的额外参数（按空格 split 后追加）     |

## 输出

- `exec_status`（status）：`ok` 表示执行成功，`error` 表示失败。

## 示例

脚本 `/opt/scripts/deploy.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
echo "deploying..."
# ...
```

组件配置：`script_path = /opt/scripts/deploy.sh`，`args = --force`。

> 注意：worker 会在 `bash` 后自动加 `-e -u -o pipefail`，
> 所以即使脚本没写 `set -e`，任一步失败也会让节点失败并跳过下游。
