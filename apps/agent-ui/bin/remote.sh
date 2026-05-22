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

# 默认值
PORT="${PORT:-7421}"
AGENT_UI_REMOTE_HOME="${AGENT_UI_REMOTE_HOME:-$HOME/.agent-ui}"
ASTROMERE_MCP_CONFIG="${ASTROMERE_MCP_CONFIG:-}"
ACTION=start
MAX_LOG_SIZE=$((50 * 1024 * 1024))  # 50MB

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

选项:
  --port <port>        监听端口 (默认: 7421, 或 \$PORT)
  --data-dir <dir>     proxy 数据目录 (默认: ~/.agent-ui, 或 \$AGENT_UI_REMOTE_HOME)
  --mcp-config <path>  MCP 配置路径 (或 \$ASTROMERE_MCP_CONFIG)
  --stop               停止运行中的实例
  --status             查看运行状态及最近日志
  -h, --help           显示此帮助
EOF
}

# 解析参数
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

# 工具函数
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
pid_running() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

# 验证端口
validate_port() {
  if ! [[ "$1" =~ ^[0-9]+$ ]] || (( $1 < 1024 || $1 > 65535 )); then
    echo "错误: 无效端口 $1 (范围: 1024-65535)" >&2
    exit 1
  fi
}

# 日志轮转
rotate_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [[ $size -gt $MAX_LOG_SIZE ]]; then
      mv "$LOG_FILE" "${LOG_FILE%.log}.$(date '+%Y%m%d_%H%M%S').log"
      log "日志已轮转 (原大小: $((size / 1024 / 1024))MB)"
    fi
  fi
}

# 停止服务
do_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "未找到 PID 文件，服务未在运行。" >&2
    exit 1
  fi

  PID="$(cat "$PID_FILE")"
  if ! pid_running "$PID"; then
    echo "进程 $PID 已不存在，清理 PID 文件。"
    rm -f "$PID_FILE"
    exit 0
  fi

  log "正在停止 (PID: $PID)..."
  kill "$PID"
  
  # 等待进程退出
  for _ in {1..20}; do
    pid_running "$PID" || break
    sleep 0.25
  done
  
  if pid_running "$PID"; then
    log "进程未响应，强制终止..."
    kill -9 "$PID" 2>/dev/null || true
    sleep 0.5
  fi
  
  rm -f "$PID_FILE"
  echo "已停止 (PID: $PID)"
  exit 0
}

# 查看状态
do_status() {
  if [[ -f "$PID_FILE" ]] && pid_running "$(cat "$PID_FILE")"; then
    local pid="$(cat "$PID_FILE")"
    echo "运行中 (PID: $pid, 端口: $PORT)"
    
    # 显示进程信息
    if command -v ps &>/dev/null; then
      ps -p "$pid" -o pid,ppid,etime,rss,command --no-headers 2>/dev/null || true
    fi
    
    echo ""
    echo "── 最近 20 行日志 ──"
    if [[ -f "$LOG_FILE" ]]; then
      tail -20 "$LOG_FILE"
    else
      echo "(暂无日志)"
    fi
    exit 0
  else
    echo "未运行"
    rm -f "$PID_FILE"
    exit 1
  fi
}

# 启动服务
do_start() {
  # 环境检查
  if ! command -v bun &>/dev/null; then
    echo "错误: 找不到 bun，请先安装 https://bun.sh" >&2
    exit 1
  fi
  
  if [[ ! -f "$PROXY_SCRIPT" ]]; then
    echo "错误: 找不到代理脚本 $PROXY_SCRIPT" >&2
    exit 1
  fi

  validate_port "$PORT"

  # 检查是否已在运行
  if [[ -f "$PID_FILE" ]]; then
    if pid_running "$(cat "$PID_FILE")"; then
      echo "错误: 服务已在运行 (PID: $(cat "$PID_FILE"))" >&2
      echo "使用 --stop 停止后重试。" >&2
      exit 1
    else
      # 清理僵尸 PID 文件
      rm -f "$PID_FILE"
    fi
  fi

  # 准备目录
  mkdir -p "$LOG_DIR"
  mkdir -p "$AGENT_UI_REMOTE_HOME"
  rotate_log

  # 导出环境变量
  export PORT
  export AGENT_UI_REMOTE_HOME
  export ASTROMERE_MCP_CONFIG

  # 输出启动信息
  {
    log "════════════════════════════════════════"
    log "  agent-ui remote proxy"
    log "  端口    : $PORT"
    log "  数据目录: $AGENT_UI_REMOTE_HOME"
    [[ -n "$ASTROMERE_MCP_CONFIG" ]] && log "  MCP配置 : $ASTROMERE_MCP_CONFIG"
    log "  bun     : $(bun --version 2>/dev/null || echo unknown)"
    log "════════════════════════════════════════"
  } | tee -a "$LOG_FILE"

  # 启动进程（使用原子操作写入 PID）
  bun run "$PROXY_SCRIPT" >> "$LOG_FILE" 2>&1 &
  PID=$!
  
  # 等待并验证启动
  sleep 0.5
  if ! pid_running "$PID"; then
    log "错误: 进程启动失败，查看日志: $LOG_FILE"
    # 显示最后几行日志帮助诊断
    [[ -f "$LOG_FILE" ]] && tail -5 "$LOG_FILE" >&2
    exit 1
  fi
  
  echo "$PID" > "$PID_FILE"
  
  echo "✓ 已启动"
  echo "  PID : $PID"
  echo "  端口: $PORT"
  echo "  数据: $AGENT_UI_REMOTE_HOME"
  echo "  日志: $LOG_FILE"
  echo "  停止: $(basename "$0") --stop"
}

# 主逻辑
case "$ACTION" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  *)      echo "错误: 未知操作 $ACTION" >&2; usage; exit 1 ;;
esac
