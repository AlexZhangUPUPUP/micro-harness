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
- 2026-10-15 · P6 · GUI: packages/gui (React 19 + Vite + Tailwind, PiStudio design tokens) wired to the server — session list, streaming transcript, tool cards, multi-agent tree with per-agent cost, trace panel + replay scrubber. Event→view logic is pure (src/lib/derive.ts, unit-tested). Fixed two real bugs found by running it: the server never exposed the `task` tool (no multi-agent over HTTP) and the GUI treated the server's normal SSE close as an error (reconnect loop). 73 tests, typecheck, vite build, CI builds the gui; screenshot docs/gui.png OCR-verified.
- 2026-10-15 · P7 · worktree isolation + merge queue: core (ported from PiStudio's proven worktree.js/merge.js, typed facade), AgentRunner.isolation + `agent.worktree` event, CLI --isolate, server MICRO_ISOLATE=1 + agents/diff/promote/cleanup/integrate endpoints, GUI wt badge + changes panel. Fixed a real bug: sub-agent events overwrote the session header (child session.start changed the session cwd/model; child turn.end marked it done). 79 tests, tsc clean, real mock+GUI screenshot OCR-verified.

- 2026-10-16 · P9（部分）· 上下文经济性：工具输出写入时截断 + 保留头部的压缩策略（前缀稳定）+ 三家缓存方言归一化 + 缓存折扣计价 + GUI 命中率 · `bun test` 122/122、typecheck 干净；真 DeepSeek 三次调用命中 75%/78%/69%，成本按缓存价计（不计价会高估 ~2x）

- 2026-10-16 · 架构 · **删除自研插件内核（P1 回退）** + 文件系统变成能力接缝（`FileSystem` 接口 → `localFs` provider；worktree 子 agent 变成一次 provider 替换）· `bun test` 112/112、typecheck 干净；新测试证明真工具可跑在内存文件系统上
- 2026-10-16 · 文档 · 新增中英双语 `docs/design-comparison.{md,zh-CN.md}`：与 DeepSeek Harness / pi / Claude Code / Codex 的五轴对比、抄了什么、拒绝了什么、以及我们的不确定项

