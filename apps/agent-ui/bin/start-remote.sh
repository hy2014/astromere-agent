#!/usr/bin/env bash
# start-remote.sh — 启动 agent-ui dev remote proxy（后台运行）
# 日志输出到 logs/remote.log
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/remote.log"
PID_FILE="$LOG_DIR/remote.pid"
PROXY_SCRIPT="$APP_DIR/scripts/dev-remote-proxy.ts"

PORT="${PORT:-7421}"
AGENT_UI_REMOTE_HOME="${AGENT_UI_REMOTE_HOME:-}"
ASTROMERE_MCP_CONFIG="${ASTROMERE_MCP_CONFIG:-}"
ACTION=start

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

选项:
  --port <port>        监听端口 (默认: 7421, 或 \$PORT)
  --data-dir <dir>     proxy 数据目录 (默认: ~/.agent-ui-proxy-test, 或 \$AGENT_UI_REMOTE_HOME)
  --mcp-config <path>  MCP 配置路径 (或 \$ASTROMERE_MCP_CONFIG)
  --stop               停止运行中的实例
  --status             查看运行状态及最近日志
  -h, --help           显示此帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)       PORT="$2";                 shift 2 ;;
    --data-dir)   AGENT_UI_REMOTE_HOME="$2"; shift 2 ;;
    --mcp-config) ASTROMERE_MCP_CONFIG="$2"; shift 2 ;;
    --stop)       ACTION=stop;               shift ;;
    --status)     ACTION=status;             shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
pid_running() { kill -0 "$1" 2>/dev/null; }

if [[ "$ACTION" == stop ]]; then
  [[ -f "$PID_FILE" ]] || { echo "未找到 PID 文件，未在运行。" >&2; exit 1; }
  PID="$(cat "$PID_FILE")"
  if pid_running "$PID"; then
    kill "$PID"
    for _ in {1..20}; do pid_running "$PID" || break; sleep 0.25; done
    pid_running "$PID" && kill -9 "$PID"
    echo "已停止 (PID: $PID)"
  else
    echo "进程 $PID 已不存在，清理 PID 文件。"
  fi
  rm -f "$PID_FILE"; exit 0
fi

if [[ "$ACTION" == status ]]; then
  if [[ -f "$PID_FILE" ]] && pid_running "$(cat "$PID_FILE")"; then
    echo "运行中 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
    echo "── 最近 20 行日志 ──"
    [[ -f "$LOG_FILE" ]] && tail -20 "$LOG_FILE" || echo "(暂无日志)"
    exit 0
  else
    echo "未运行"; rm -f "$PID_FILE"; exit 1
  fi
fi

# start
if ! command -v bun &>/dev/null; then
  echo "错误: 找不到 bun，请先安装 https://bun.sh" >&2; exit 1
fi
if [[ ! -f "$PROXY_SCRIPT" ]]; then
  echo "错误: 找不到 $PROXY_SCRIPT" >&2; exit 1
fi

if [[ -f "$PID_FILE" ]] && pid_running "$(cat "$PID_FILE")"; then
  echo "已在运行 (PID: $(cat "$PID_FILE"))，使用 --stop 停止后重试。" >&2; exit 1
fi
rm -f "$PID_FILE"
mkdir -p "$LOG_DIR"

# 超过 50 MB 轮转日志
if [[ -f "$LOG_FILE" ]] && [[ $(wc -c < "$LOG_FILE") -gt $((50 * 1024 * 1024)) ]]; then
  mv "$LOG_FILE" "${LOG_FILE%.log}.$(date '+%Y%m%d_%H%M%S').log"
fi

export PORT
[[ -n "$AGENT_UI_REMOTE_HOME" ]] && export AGENT_UI_REMOTE_HOME
[[ -n "$ASTROMERE_MCP_CONFIG" ]] && export ASTROMERE_MCP_CONFIG

{
  log "════════════════════════════════════════"
  log "  agent-ui remote proxy"
  log "  端口    : $PORT"
  log "  数据目录: ${AGENT_UI_REMOTE_HOME:-~/.agent-ui-proxy-test}"
  [[ -n "$ASTROMERE_MCP_CONFIG" ]] && log "  MCP     : $ASTROMERE_MCP_CONFIG"
  log "  bun     : $(bun --version 2>/dev/null || echo unknown)"
  log "════════════════════════════════════════"
} | tee -a "$LOG_FILE"

bun run "$PROXY_SCRIPT" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "已启动 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
echo "日志: $LOG_FILE"
echo "停止: $(basename "$0") --stop"
