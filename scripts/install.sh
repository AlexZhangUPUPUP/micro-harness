#!/usr/bin/env bash
# Build and install `micro-harness` as a single-file binary.
#
#   ./scripts/install.sh                        # -> ~/.local/bin/micro-harness
#   PREFIX=/usr/local/bin ./scripts/install.sh  # somewhere else on PATH
#
# One command, no publish required: compiles packages/core/src/cli.ts into a
# self-contained binary (Bun runtime + CLI) and copies it onto your PATH.
# The server and GUI are separate processes; start them with scripts/dev.sh.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"

command -v bun >/dev/null 2>&1 || {
  echo "bun is required (https://bun.sh)" >&2
  exit 1
}

cd "$DIR"

echo "• building dist/micro-harness (this takes ~10s)…"
bun run build:bin

mkdir -p "$PREFIX"
install -m 0755 dist/micro-harness "$PREFIX/micro-harness"
echo "✓ installed: $PREFIX/micro-harness"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "  note: $PREFIX is not on your PATH — add it to use 'micro-harness' directly" ;;
esac

echo "  version:  $("$PREFIX/micro-harness" --version)"
echo "  next:     export MICRO_API_KEY=…   then   micro-harness \"…\""
echo "  evaluate: bun run eval:mock        (offline, CI-safe)"
