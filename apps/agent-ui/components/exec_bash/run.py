#!/usr/bin/env python3
"""执行bash脚本组件 (exec_bash)。

契约（必须与 agent-ui 里「执行bash脚本」组件的注册配置一致）：
- 0 个输入端口
- 1 个输出端口：exec_status（type=status）
- config 参数（经 AGENT_UI_INPUT_PATH 下发，key 即参数名）：
    - script_path：bash 脚本路径（必填，type=path）—— worker 机器上可访问的绝对路径
    - args       ：传给脚本的额外参数（可选，type=string）

运行模型：
- 引擎写死 `[python, entry_point]`，故本文件是 Python 壳，内部再用
  `bash -e -u -o pipefail` 调起目标脚本。
- 退出码即成败：非 0 → 节点失败、下游被 skip；0 → 节点成功。
- 即便脚本本身没写 `set -e`，`-e -u -o pipefail` 包装也能保证“任一步失败即整体失败”。
"""

import json
import os
import subprocess
import sys


def _read_input():
    path = os.environ.get("AGENT_UI_INPUT_PATH")
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except Exception:
            return {}


def _write_output(payload):
    path = os.environ.get("AGENT_UI_OUTPUT_PATH")
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)


def _check_set_e(script_path: str) -> bool:
    """扫描脚本前若干行，判断是否有 `set -e`（-euo pipefail 也算）。"""
    try:
        with open(script_path, "r", encoding="utf-8", errors="replace") as f:
            head = "".join(next(f) for _ in range(40))
    except Exception:
        return False
    return "set -e" in head or "set -eu" in head or "set -o errexit" in head


def main():
    data = _read_input()

    script_path = (data.get("script_path") or "").strip()
    if not script_path:
        sys.stderr.write("缺少必填参数 script_path（bash 脚本路径）。\n")
        _write_output({"exec_status": {"status": "error", "error": "missing script_path"}})
        return 1
    if not os.path.isfile(script_path):
        sys.stderr.write(f"脚本不存在或不是文件：{script_path}\n")
        _write_output({"exec_status": {"status": "error", "error": f"script not found: {script_path}"}})
        return 1

    # Pre-check: if the script doesn't declare set -e, our -e wrapper still catches failures at runtime; here we only warn, not block.
    if not _check_set_e(script_path):
        sys.stderr.write(
            "警告：脚本未检测到 `set -e`，已自动以 `bash -e -u -o pipefail` 包装执行，"
            "任一步失败即整体失败。\n"
        )

    raw_args = (data.get("args") or "").strip()
    bash_args = raw_args.split() if raw_args else []

    cmd = ["bash", "-e", "-u", "-o", "pipefail", script_path, *bash_args]
    sys.stderr.write(f"执行命令：{' '.join(cmd)}\n")

    try:
        proc = subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        sys.stderr.write(f"bash 脚本执行失败（退出码 {e.returncode}）。\n")
        _write_output({"exec_status": {"status": "error", "error": f"bash exited {e.returncode}"}})
        return e.returncode or 1
    except FileNotFoundError:
        sys.stderr.write("未找到 bash 可执行文件。\n")
        _write_output({"exec_status": {"status": "error", "error": "bash not found"}})
        return 1

    _write_output({"exec_status": {"status": "ok"}})
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
