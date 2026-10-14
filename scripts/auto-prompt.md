# Auto-run prompt

You are running unattended in a loop (see `scripts/auto-run.sh`). Work through the
project roadmap one step at a time. Do not ask questions; make the best decision and
keep moving.

## Objective

Complete **ROADMAP phases P3 → P4 → P5**, in order. P0–P2 are done; ignore P6+.

- **P3**: multi-agent — `agents` service, `task` tool (single/parallel/chain/race),
  fork isolation, context firewall, depth/concurrency/budget limits, agent tree in CLI.
- **P4**: server — `Bun.serve` HTTP + SSE, session API (create/get/list/resume/fork/delete),
  SQLite index with FTS5, token auth beyond loopback.
- **P5**: CLI — TUI (streaming render, tool cards, approvals), slash commands/
  prompt templates/skills, multi-agent tree with per-agent cost, permission modes
  (suggest/auto-edit/full-auto), and an unattended `run --auto` driver.

Streaming (text/thinking deltas) was deferred from P2 — do it here where the CLI needs it.

## Protocol

1. Read `ROADMAP.md` and `PROGRESS.md` (tail) and `ARCHITECTURE.md`.
2. Pick the **next unchecked** item in the earliest incomplete phase.
3. Implement it **on the `platform` branch** (never `main`).
4. Verify before committing:
   - `bun test` must pass
   - `bun run typecheck` must be clean
5. Only if both pass: `git add -A && git commit` with a clear message, then
   `git push origin platform`.
6. Update `ROADMAP.md` checkboxes and append one line to `PROGRESS.md`.
7. Keep changes small: one coherent increment per iteration.

## Hard rules

- Never `git push --force`, never delete remote branches, never touch `main`.
- Never copy secrets from `~/.pi/agent/auth.json` into the repo. Tests use env vars.
- If a step is blocked (missing credential, network, platform limit), write the
  reason in `PROGRESS.md` and move to the next task instead of spinning.
- If `bun test` or typecheck fails and you cannot fix it in a few attempts, revert
  your changes (`git checkout -- .`), record it, and move on.

## How to end this iteration

End your final message with exactly one of these lines:

- `AUTO-RUN: DONE` — everything in the roadmap is complete
- `AUTO-RUN: BLOCKED` — cannot make progress without a human
- `AUTO-RUN: CONTINUE` — made progress; there is more to do
