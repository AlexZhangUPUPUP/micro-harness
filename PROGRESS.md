# Progress log

Autonomous run log. Newest last. One line per meaningful step: time · phase · what · verification.

- 2026-10-15 · P0 · monorepo restructure (src→packages/core, workspaces, Bun toolchain, CI→bun) · `bun test` 7/7, `bun run typecheck` clean
- 2026-10-15 · P1 · kernel: Context (provide/get/inject), plugin lifecycle (waiting/active/failed), scope fork+isolate, event bus, config schema · 17/17 tests, typecheck clean
- 2026-10-15 · P2a · core event-driven: events.ts (AgentEvent + EventHub/AgentLog with agentId/parentId), provider.ts (Provider + openaiProvider), harness.ts emits events + parallel tool calls + abort signal · 22/22 tests, typecheck clean
- 2026-10-15 · P3 · multi-agent: agents service + `task` tool (single/parallel/chain/race), context firewall, depth/concurrency/budget/timeout limits, agent tree + per-agent cost · 39/39 tests, typecheck clean (impl in prior commit; roadmap ticked here)
- 2026-10-15 · P4a · server package: SessionStore (JSONL truth + bun:sqlite index + FTS5 search, rebuildable), `user.message` event + `reconstructMessages` for resume · 45/45 tests, typecheck clean
- 2026-10-15 · P4b · server: Bun.serve HTTP + SSE, session API (list/get/create/resume/fork/delete), FTS search, token auth; verified with curl (health/create/search/SSE) · 52/52 tests, typecheck clean
- 2026-10-15 · P5 · CLI: streaming text/thinking deltas (chatStream in core+provider), self-drawn TUI renderer (tool cards, per-agent labels), slash commands/prompt templates/skills, interactive approvals, `run --auto` driver (queue+budget/timeout), agent tree with per-agent cost · 67/67 tests, typecheck clean; verified multi-agent run + auto-run against a fake streaming model
- 2026-10-15 · P3-P5 · verification: scripts/verify-features.ts (scripted provider, no network) — 26/26 feature checks pass (multi-agent single/parallel/chain/race, firewall, maxDepth; server health/auth/create/SSE/FTS/fork/delete/resume; streaming deltas, prompt templates, skills, runAuto budgets) + CLI end-to-end (streaming render, run --auto 3/3). Unit suite 67/67, CI green.
- 2026-10-15 · P3/P4 · REAL-MODEL round-trips (deepseek-chat): server session returned SERVER-REAL-OK + FTS hit; multi-agent CLI delegated to agent-1 (SUBOK) and the parent completed with an agent tree. This caught a real bug: streamed tool_calls lacked type:"function" → next request 422; fixed in model.ts + regression test.
