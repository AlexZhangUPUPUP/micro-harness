#!/usr/bin/env bash
# Launch micro-harness as an ACP server with the model key resolved.
#
# Editor clients (Zed and friends) start an agent command with a minimal
# environment, so a key exported in your shell is not there. Resolution order:
#
#   ~/.micro-harness/env     KEY=value lines (local; never committed)
#   ~/.pi/agent/auth.json    deepseek.key — the same source scripts/dev.sh uses
#
# Zed:
#   "agent_servers": {
#     "micro-harness": { "type": "custom", "command": "<repo>/scripts/acp.sh", "args": [] }
#   }
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"

BUN="${BUN:-$(command -v bun || true)}"
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ] && [ -x /opt/homebrew/bin/bun ]; then BUN=/opt/homebrew/bin/bun; fi
if [ -z "$BUN" ]; then
  echo "acp.sh: bun not found — install bun or set BUN to its path" >&2
  exit 1
fi

if [ -f "$HOME/.micro-harness/env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.micro-harness/env"
  set +a
fi

if [ -z "${MICRO_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  KEY="$("$BUN" -e "try{console.log(require(process.env.HOME+'/.pi/agent/auth.json').deepseek?.key||'')}catch{}" 2>/dev/null || true)"
  [ -n "$KEY" ] && export MICRO_API_KEY="$KEY"
fi

export MICRO_BASE_URL="${MICRO_BASE_URL:-https://api.deepseek.com}"
export MICRO_MODEL="${MICRO_MODEL:-deepseek-chat}"

exec "$BUN" "$DIR/packages/core/src/cli.ts" acp "$@"
