#!/usr/bin/env bash
# Run the micro-harness stack in this terminal, for the folder you launch from.
#
#   microh                       # one process (server + GUI), free port, opens a browser
#   scripts/dev.sh               # two processes (server + Vite preview), for development
#   scripts/dev.sh --no-open     # don't open a browser
#   scripts/dev.sh --restart     # stop whatever holds the base port first
#   MICRO_MODEL=… MICRO_ISOLATE=1 scripts/dev.sh
#
# The agent works in the directory you launch from (override with MICRO_CWD).
# Several folders/terminals can each run their own instance — a free port is
# picked automatically (pin one with MICRO_PORT). Closing this terminal, or
# Ctrl-C, stops everything.
#
# API key resolution: MICRO_API_KEY → DEEPSEEK_API_KEY → OPENAI_API_KEY →
# ~/.pi/agent/auth.json (deepseek.key).
set -euo pipefail

CALLER_PWD="$PWD"
cd "$(dirname "$0")/.."

# Optional local secrets/config (e.g. BOCHA_API_KEY). Never committed.
if [ -f "$HOME/.micro-harness/env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.micro-harness/env"
  set +a
fi

# --single   : serve the built GUI from the server (one process, one port)
# --no-open  : do not open a browser
# --restart  : stop whatever holds the base port, then start
SINGLE=0
OPEN=1
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --single|--static) SINGLE=1 ;;
    --open) OPEN=1 ;;
    --no-open) OPEN=0 ;;
    --restart|--force) RESTART=1 ;;
  esac
done

SERVER_PORT="${MICRO_PORT:-8787}"
GUI_PORT="${MICRO_GUI_PORT:-5273}"
MODEL="${MICRO_MODEL:-deepseek-chat}"
ISOLATE="${MICRO_ISOLATE:-0}"
MODELS="${MICRO_MODELS:-deepseek-chat,deepseek-reasoner}"
DATA_DIR="${MICRO_DATA_DIR:-$HOME/.micro-harness}"
CWD="${MICRO_CWD:-$CALLER_PWD}"
# Permission preset for new sessions: read-only | workspace | full | auto-review.
# `full` (shell + network) is the useful default for a coding agent; the GUI can
# switch it per session, and the riskier presets require a confirmation there.
PERMISSION="${MICRO_PERMISSION:-full}"

free_port() { # $1 = first candidate
  local p="$1" n=0
  while [ "$n" -lt 200 ]; do
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || { echo "$p"; return; }
    p=$((p + 1)); n=$((n + 1))
  done
  echo "$1"
}

if [ "$RESTART" = 1 ]; then
  oldpid="$(lsof -ti tcp:"$SERVER_PORT" 2>/dev/null | head -1)"
  if [ -n "$oldpid" ]; then
    echo "• --restart: stopping pid $oldpid on port $SERVER_PORT" >&2
    kill "$oldpid" 2>/dev/null || true
    sleep 1
  fi
fi

# A fresh instance per launch, so any folder can have its own. Pin with MICRO_PORT.
SERVER_PORT="$(free_port "$SERVER_PORT")"
if [ "$SINGLE" = 1 ]; then
  GUI_PORT="$SERVER_PORT"
else
  GUI_PORT="$(free_port "$GUI_PORT")"
  [ "$GUI_PORT" = "$SERVER_PORT" ] && GUI_PORT="$(free_port $((GUI_PORT + 1)))"
fi

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

LOG_DIR="${TMPDIR:-/tmp}"
SRV=""; GUI=""
cleanup() {
  [ -n "$GUI" ] && kill "$GUI" 2>/dev/null || true
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true
}
# HUP: closing the terminal stops everything. INT/TERM: Ctrl-C / kill.
trap cleanup EXIT INT TERM HUP

MICRO_PORT="$SERVER_PORT" MICRO_CWD="$CWD" MICRO_DATA_DIR="$DATA_DIR" MICRO_MODEL="$MODEL" MICRO_MODELS="$MODELS" MICRO_ISOLATE="$ISOLATE" MICRO_PERMISSION="$PERMISSION" MICRO_API_KEY="$KEY" MICRO_SERVE_GUI="$([ "$SINGLE" = 1 ] && echo 1 || echo 0)" MICRO_EXIT_WITH_PARENT=1 \
MICRO_PRICE_INPUT="${MICRO_PRICE_INPUT:-}" MICRO_PRICE_OUTPUT="${MICRO_PRICE_OUTPUT:-}" \
MICRO_PRICE_INPUT_CACHED="${MICRO_PRICE_INPUT_CACHED:-}" MICRO_MAX_TOOL_OUTPUT="${MICRO_MAX_TOOL_OUTPUT:-}" \
MICRO_MAX_COST="${MICRO_MAX_COST:-}" MICRO_MAX_CONTEXT="${MICRO_MAX_CONTEXT:-}" MICRO_SANDBOX="${MICRO_SANDBOX:-}" \
  bun packages/server/src/main.ts >"$LOG_DIR/micro-harness-server.log" 2>&1 &
SRV=$!

# If the port was somehow taken, Bun.serve throws and our process dies. `kill -0`
# succeeds for an unreaped zombie, so check the process state too.
sleep 0.5
if ! kill -0 "$SRV" 2>/dev/null || [ "$(ps -o state= -p "$SRV" 2>/dev/null | tr -d ' ')" = "Z" ]; then
  echo "✗ server did not start on port $SERVER_PORT." >&2
  [ -f "$LOG_DIR/micro-harness-server.log" ] && sed 's/^/  | /' "$LOG_DIR/micro-harness-server.log" >&2 || true
  exit 1
fi

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done

if [ "$SINGLE" = 0 ]; then
  (cd packages/gui && MICRO_SERVER="http://127.0.0.1:$SERVER_PORT" MICRO_GUI_PORT="$GUI_PORT" bun run preview >"$LOG_DIR/micro-harness-gui.log" 2>&1) &
  GUI=$!

  # wait for the GUI to answer
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

cat <<EOF

  micro-harness is running in this terminal$([ "$SINGLE" = 1 ] && echo ' (single process)')

    GUI     http://127.0.0.1:$GUI_PORT      ← open this
    API     http://127.0.0.1:$SERVER_PORT
    cwd     $CWD
    model   $MODEL
    key     ${KEY:0:11}… (from $KEY_SRC)
    isolation $([ "$ISOLATE" = 1 ] && echo 'worktree (each agent gets its own git worktree)' || echo 'off (set MICRO_ISOLATE=1 to enable)')
    permission $PERMISSION
    sandbox    ${MICRO_SANDBOX:-off}
    data    $DATA_DIR
    logs    $LOG_DIR/micro-harness-{server,gui}.log

  Type a task in the GUI and press Enter. Ctrl-C, or closing this terminal, stops everything.

EOF

if [ "$OPEN" = 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:$GUI_PORT/" >/dev/null 2>&1 || true
  fi
fi

wait
