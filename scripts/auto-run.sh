#!/usr/bin/env bash
# Guarded autonomous driver: repeatedly hand the next roadmap step to pi and stop
# on success, blockage, or the iteration limit.
#
#   scripts/auto-run.sh                 # up to MAX_ITERS iterations
#   MAX_ITERS=80 PER_TIMEOUT=2700 scripts/auto-run.sh
#   ITER_ARGS="--thinking high" scripts/auto-run.sh
#
# Stop it any time with:  pkill -f 'pi -c -p'
set -uo pipefail

cd "$(dirname "$0")/.."
BRANCH="${BRANCH:-platform}"
MAX_ITERS="${MAX_ITERS:-40}"
PER_TIMEOUT="${PER_TIMEOUT:-1800}" # seconds per iteration (30 min)
LOG="${LOG:-.auto-run.log}"
PROMPT_FILE="${PROMPT_FILE:-scripts/auto-prompt.md}"
ITER_ARGS="${ITER_ARGS:-}"
# SESSION_FLAG: "-c" keeps one growing session; "--no-session" makes each
# iteration stateless (the repo's ROADMAP/PROGRESS carry the memory). For long
# unattended runs the stateless mode is usually the more robust choice.
SESSION_FLAG="${SESSION_FLAG:--c}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo"; exit 1; }
git checkout "$BRANCH" >/dev/null 2>&1 || { echo "cannot checkout $BRANCH"; exit 1; }

PROMPT="$(cat "$PROMPT_FILE")"
echo "auto-run: branch=$BRANCH max=$MAX_ITERS timeout=${PER_TIMEOUT}s session=${SESSION_FLAG} log=$LOG" | tee -a "$LOG"

for i in $(seq 1 "$MAX_ITERS"); do
  echo "=== iteration $i · $(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "$LOG"

  iterlog="$(mktemp)"
  # shellcheck disable=SC2086
  pi $SESSION_FLAG -p $ITER_ARGS "$PROMPT" >"$iterlog" 2>&1 &
  pid=$!
  # portable watchdog (macOS has no `timeout`)
  ( sleep "$PER_TIMEOUT"; kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null ) &
  watcher=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watcher" 2>/dev/null

  cat "$iterlog" >>"$LOG"
  rm -f "$iterlog"

  if [ "$rc" -ne 0 ]; then
    echo "--- iteration $i exited rc=$rc (timeout or error)" | tee -a "$LOG"
  fi

  if grep -q 'AUTO-RUN: DONE' "$LOG"; then
    echo "auto-run: DONE" | tee -a "$LOG"
    break
  fi
  if grep -q 'AUTO-RUN: BLOCKED' "$LOG"; then
    echo "auto-run: BLOCKED — needs a human" | tee -a "$LOG"
    break
  fi
done

echo "auto-run: finished at $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG"
