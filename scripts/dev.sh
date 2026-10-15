#!/usr/bin/env bash
# One-command dev stack: micro-harness server + the React GUI.
#
#   scripts/dev.sh                     # http://127.0.0.1:5273
#   MICRO_MODEL=deepseek-reasoner scripts/dev.sh
#   MICRO_MODELS=deepseek-chat,deepseek-reasoner scripts/dev.sh   # GUI model picker
#   MICRO_PORT=8787 MICRO_GUI_PORT=5273 scripts/dev.sh
#
# API key resolution order: MICRO_API_KEY → DEEPSEEK_API_KEY → OPENAI_API_KEY →
# ~/.pi/agent/auth.json (deepseek.key). Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_PORT="${MICRO_PORT:-8787}"
GUI_PORT="${MICRO_GUI_PORT:-5273}"
MODEL="${MICRO_MODEL:-deepseek-chat}"
ISOLATE="${MICRO_ISOLATE:-0}"
MODELS="${MICRO_MODELS:-}"
DATA_DIR="${MICRO_DATA_DIR:-$HOME/.micro-harness}"

KEY="${MICRO_API_KEY:-${DEEPSEEK_API_KEY:-${OPENAI_API_KEY:-}}}"
if [ -z "$KEY" ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  KEY="$(bun -e "try{console.log(require(process.env.HOME+'/.pi/agent/auth.json').deepseek?.key||'')}catch{console.log('')}" 2>/dev/null || true)"
fi
if [ -z "$KEY" ]; then
  echo "no API key found — set MICRO_API_KEY (or DEEPSEEK_API_KEY), or add one to ~/.pi/agent/auth.json" >&2
  exit 1
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

MICRO_PORT="$SERVER_PORT" MICRO_DATA_DIR="$DATA_DIR" MICRO_MODEL="$MODEL" MICRO_MODELS="$MODELS" MICRO_ISOLATE="$ISOLATE" MICRO_API_KEY="$KEY" \
  bun packages/server/src/main.ts >/tmp/micro-harness-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done

(cd packages/gui && MICRO_SERVER="http://127.0.0.1:$SERVER_PORT" MICRO_GUI_PORT="$GUI_PORT" bun run preview >/tmp/micro-harness-gui.log 2>&1) &
GUI=$!

# wait for the GUI to answer
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done

cat <<EOF

  micro-harness is running

    GUI     http://127.0.0.1:$GUI_PORT      ← open this
    API     http://127.0.0.1:$SERVER_PORT
    model   $MODEL
    isolation $([ "$ISOLATE" = 1 ] && echo 'worktree (each agent gets its own git worktree)' || echo 'off (set MICRO_ISOLATE=1 to enable)')
    data    $DATA_DIR
    logs    /tmp/micro-harness-{server,gui}.log

  Type a task in the GUI and press Enter. Ctrl-C stops everything.

EOF

wait
