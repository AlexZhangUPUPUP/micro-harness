#!/usr/bin/env bash
# One-command dev stack: micro-harness server + the React GUI.
#
#   scripts/dev.sh                     # http://127.0.0.1:5273
#   MICRO_MODEL=deepseek-reasoner scripts/dev.sh
#   MICRO_MODELS=deepseek-chat,deepseek-reasoner scripts/dev.sh   # GUI model picker
#   MICRO_PRICE_INPUT=0.27 MICRO_PRICE_INPUT_CACHED=0.027 MICRO_PRICE_OUTPUT=1.10 scripts/dev.sh
#   MICRO_PORT=8787 MICRO_GUI_PORT=5273 scripts/dev.sh
#
# API key resolution order: MICRO_API_KEY → DEEPSEEK_API_KEY → OPENAI_API_KEY →
# ~/.pi/agent/auth.json (deepseek.key). Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

# --single : serve the built GUI from the server (one process, one port)
# --no-open: do not open a browser
SINGLE=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --single|--static) SINGLE=1 ;;
    --open) OPEN=1 ;;
    --no-open) OPEN=0 ;;
  esac
done

SERVER_PORT="${MICRO_PORT:-8787}"
GUI_PORT="${MICRO_GUI_PORT:-5273}"
[ "$SINGLE" = 1 ] && GUI_PORT="$SERVER_PORT"
MODEL="${MICRO_MODEL:-deepseek-chat}"
ISOLATE="${MICRO_ISOLATE:-0}"
MODELS="${MICRO_MODELS:-}"
DATA_DIR="${MICRO_DATA_DIR:-$HOME/.micro-harness}"

AUTH_KEY=""
if [ -f "$HOME/.pi/agent/auth.json" ]; then
  AUTH_KEY="$(bun -e "try{console.log(require(process.env.HOME+'/.pi/agent/auth.json').deepseek?.key||'')}catch{console.log('')}" 2>/dev/null || true)"
fi

KEY=""; KEY_SRC=""
if [ -n "${MICRO_API_KEY:-}" ]; then KEY="$MICRO_API_KEY"; KEY_SRC="MICRO_API_KEY (env)"
elif [ -n "${DEEPSEEK_API_KEY:-}" ]; then KEY="$DEEPSEEK_API_KEY"; KEY_SRC="DEEPSEEK_API_KEY (env)"
elif [ -n "${OPENAI_API_KEY:-}" ]; then KEY="$OPENAI_API_KEY"; KEY_SRC="OPENAI_API_KEY (env)"
elif [ -n "$AUTH_KEY" ]; then KEY="$AUTH_KEY"; KEY_SRC="~/.pi/agent/auth.json"
fi
if [ -z "$KEY" ]; then
  echo "no API key found — set MICRO_API_KEY (or DEEPSEEK_API_KEY), or add one to ~/.pi/agent/auth.json" >&2
  exit 1
fi
# An exported key silently shadowing a different one in auth.json is the classic
# "why is my balance zero" trap: make it loud instead of debugging a 402 later.
if [ -n "$AUTH_KEY" ] && [ "$KEY" != "$AUTH_KEY" ]; then
  echo "warning: the key from $KEY_SRC (${KEY:0:11}…) differs from ~/.pi/agent/auth.json (${AUTH_KEY:0:11}…)." >&2
  echo "         Using the former. If it is stale, run: env -u DEEPSEEK_API_KEY scripts/dev.sh" >&2
fi

if [ ! -f packages/gui/dist/index.html ]; then
  echo "• building the GUI…" >&2
  (cd packages/gui && bun run build >/dev/null)
fi

SRV=""; GUI=""
cleanup() {
  [ -n "$GUI" ] && kill "$GUI" 2>/dev/null || true
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Refuse to start if something already serves on this port — otherwise Bun.serve
# throws, our process dies, and an older server silently keeps answering /health
# (the classic "why is my GUI still the old one" trap).
if curl -sf "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1; then
  echo "✗ a micro-harness server is already running on port $SERVER_PORT." >&2
  echo "  stop it:  pkill -f 'micro-harness/packages/server'; pkill -f 'scripts/dev.sh'" >&2
  echo "  or pick another port:  MICRO_PORT=8888 $0 --single" >&2
  exit 1
fi

MICRO_PORT="$SERVER_PORT" MICRO_DATA_DIR="$DATA_DIR" MICRO_MODEL="$MODEL" MICRO_MODELS="$MODELS" MICRO_ISOLATE="$ISOLATE" MICRO_API_KEY="$KEY" MICRO_SERVE_GUI="$([ "$SINGLE" = 1 ] && echo 1 || echo 0)" \
MICRO_PRICE_INPUT="${MICRO_PRICE_INPUT:-}" MICRO_PRICE_OUTPUT="${MICRO_PRICE_OUTPUT:-}" \
MICRO_PRICE_INPUT_CACHED="${MICRO_PRICE_INPUT_CACHED:-}" MICRO_MAX_TOOL_OUTPUT="${MICRO_MAX_TOOL_OUTPUT:-}" \
  bun packages/server/src/main.ts >/tmp/micro-harness-server.log 2>&1 &
SRV=$!

# If the port was taken by a non-HTTP service, Bun.serve throws and our process
# dies. `kill -0` succeeds for an unreaped zombie, so check the process state too.
sleep 0.5
if ! kill -0 "$SRV" 2>/dev/null || [ "$(ps -o state= -p "$SRV" 2>/dev/null | tr -d ' ')" = "Z" ]; then
  echo "✗ server did not start on port $SERVER_PORT." >&2
  [ -f /tmp/micro-harness-server.log ] && sed 's/^/  | /' /tmp/micro-harness-server.log >&2 || true
  exit 1
fi

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done

if [ "$SINGLE" = 0 ]; then
  (cd packages/gui && MICRO_SERVER="http://127.0.0.1:$SERVER_PORT" MICRO_GUI_PORT="$GUI_PORT" bun run preview >/tmp/micro-harness-gui.log 2>&1) &
  GUI=$!

  # wait for the GUI to answer
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

cat <<EOF

  micro-harness is running$([ "$SINGLE" = 1 ] && echo ' (single process)')

    GUI     http://127.0.0.1:$GUI_PORT      ← open this
    API     http://127.0.0.1:$SERVER_PORT
    model   $MODEL
    key     ${KEY:0:11}… (from $KEY_SRC)
    isolation $([ "$ISOLATE" = 1 ] && echo 'worktree (each agent gets its own git worktree)' || echo 'off (set MICRO_ISOLATE=1 to enable)')
    data    $DATA_DIR
    logs    /tmp/micro-harness-{server,gui}.log

  Type a task in the GUI and press Enter. Ctrl-C stops everything.

EOF

if [ "$OPEN" = 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 || true
  fi
fi

wait
