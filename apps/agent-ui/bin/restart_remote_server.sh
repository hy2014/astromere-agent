#!/usr/bin/env bash
# restart_remote_server.sh — 编译并重启 agent-ui remote 服务器
# 用法:
#   ./bin/restart_remote_server.sh                  # 编译 + 重启（默认）
#   ./bin/restart_remote_server.sh --no-build       # 仅重启，不编译
#   ./bin/restart_remote_server.sh --stop           # 仅停止
#   ./bin/restart_remote_server.sh --status         # 查看状态
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PROJECT_DIR/src-tauri"
LOG_DIR="$SRC_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"
BIN_PATH="$SRC_DIR/target/release/claw-agent-ui"

HOST="${AGENT_UI_HTTP_HOST:-0.0.0.0}"
PORT="${AGENT_UI_HTTP_PORT:-7421}"
ACTION=restart
DO_BUILD=true

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

选项:
  --no-build   跳过编译，仅重启
  --stop       仅停止
  --status     查看运行状态
  -h, --help   显示帮助

环境变量:
  AGENT_UI_HTTP_HOST  绑定地址 (默认: 0.0.0.0)
  AGENT_UI_HTTP_PORT  端口     (默认: 7421)
EOF
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)  DO_BUILD=true;                                            shift ;;
    --stop)   ACTION=stop;                                              shift ;;
    --status) ACTION=status;                                            shift ;;
    -h|--help) usage; exit 0 ;;
    *)        echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

# ── 工具函数 ─────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
pid_running() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

# ── 停止 ─────────────────────────────────────────────────────────────
do_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "未找到 PID 文件，服务可能未在运行。"
    return 0
  fi

  PID="$(cat "$PID_FILE")"
  if ! pid_running "$PID"; then
    echo "进程 $PID 已退出，清理 PID 文件。"
    rm -f "$PID_FILE"
    return 0
  fi

  log "正在停止 (PID: $PID)..."
  kill "$PID" 2>/dev/null || true

  for _ in {1..10}; do
    pid_running "$PID" || break
    sleep 0.5
  done

  if pid_running "$PID"; then
    log "强制终止..."
    kill -9 "$PID" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  log "已停止"
}

# ── 状态 ───────────────────────────────────────────────────────────
do_status() {
  if [[ -f "$PID_FILE" ]] && pid_running "$(cat "$PID_FILE")"; then
    local pid="$(cat "$PID_FILE")"
    echo "运行中 (PID: $pid, $HOST:$PORT)"
    ps -p "$pid" -o pid,ppid,etime,rss,command --no-headers 2>/dev/null || true
    echo ""
    echo "── 最近日志 ──"
    [[ -f "$LOG_FILE" ]] && tail -10 "$LOG_FILE" || echo "(无日志)"
  else
    echo "未运行"
    rm -f "$PID_FILE"
  fi
}

# ── 编译 ─────────────────────────────────────────────────────────────
do_build() {
  log "编译 --no-default-features..."
  cd "$SRC_DIR"
  cargo build --release --no-default-features
  log "编译完成→ $BIN_PATH"
}

# ── 启动 ───────────────────────────────────────────────────────────
do_start() {
  if [[ -f "$PID_FILE" ]] && pid_running "$(cat "$PID_FILE")"; then
    echo "已在运行 (PID: $(cat "$PID_FILE"))，先执行 --stop 再重启。"
    exit 1
  fi

  if [[ ! -f "$BIN_PATH" ]]; then
    echo "未找到二进制文件: $BIN_PATH" >&2
    echo "请先运行: $(basename "$0") --build" >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR"

  log "启动 remote server → $HOST:$PORT"
  AGENT_UI_HTTP_HOST="$HOST" \
  AGENT_UI_HTTP_PORT="$PORT" \
    nohup "$BIN_PATH" >> "$LOG_FILE" 2>&1 &
  PID=$!

  sleep 1
  if ! pid_running "$PID"; then
    log "启动失败，查看日志:"
    tail -20 "$LOG_FILE"
    exit 1
  fi

  echo "$PID" > "$PID_FILE"
  log "已启动 (PID: $PID)"

  # 健康检查
  if command -v curl &>/dev/null; then
    sleep 1
    if curl -sf "http://127.0.0.1:$PORT/health" &>/dev/null; then
      log "健康检查通过 ✓"
    else
      log "健康检查失败，查看日志"
    fi
  fi
}

# ── 主逻辑 ─────────────────────────────────────────────────────────
case "$ACTION" in
  restart)
    do_stop
    $DO_BUILD && do_build
    sleep 0.5
    do_start
    ;;
  stop)
    do_stop
    ;;
  status)
    do_status
    ;;
esac
