# Design notes: the trade-offs behind micro-harness

> This is a **design comparison**, not a benchmark. Everything about other tools is drawn from their public docs or source, listed at the end; those projects move quickly, so treat this as a dated snapshot and send corrections. Everything about ours points at code you can open right now.

In one line: micro-harness is not trying to be the most capable harness. It is trying to **keep a complete harness at a size you can read and verify** — where the core is not replaced by the platform, and every decision can be checked in the repository.

---

## Five questions that separate harnesses

Feature lists make every harness look alike. These five questions separate the designs:

| # | Question | What it decides |
|---|---|---|
| 1 | Does the core own the agent loop? | If the loop is replaceable you are building a **runtime**; otherwise an **application**. |
| 2 | What is the unit of extension, and when does it load? | A DI container, a registry API and a compile-time interface are three different cost structures. |
| 3 | What are events for? | Logging, an observability contract, or the **extension surface itself**. |
| 4 | How is history managed? | Compaction, branching, replay — and whether what the model actually saw is kept. |
| 5 | How does generated code land? | Sandbox or worktree, and **who decides what gets applied**. |

---

## Side by side

`—` means we did **not find a description in the other project's public material**; it does not mean the capability is absent. This is a snapshot — see the date and sources below.

| | micro-harness | DeepSeek Harness (dsh) | pi | Claude Code | Codex |
|---|---|---|---|---|---|
| Shape | a platform in one repo, plus a frozen readable seed | a standalone runtime | a minimal terminal harness | closed-source product | open-source CLI (`openai/codex`) |
| Core owns the loop | **yes** — `Harness` runs the loop and dispatches tools | the docs describe the whole chain as pluggable, including the loop | small core + large extension surface | — | — |
| Unit of extension / load time | **compile-time seams** (`Provider`/`Tool`/`FileSystem`/`AgentRole`) + config-driven MCP | Cordis plugins, loaded at runtime | TypeScript extensions registered at startup | hooks | `AGENTS.md` + repo conventions |
| Events | **the single contract** — log, SSE, trace, replay, agent tree and inspector are all consumers of one stream | staged event points (`turn/*`, `step/*`, `llm/stream`, `tools/*`) | RPC + SDK + JSON output | hooks | — |
| "Model-visible means recorded" | **implemented**: every call emits `model.request` with the system prompt, tool schemas, message array and token estimate | an architectural invariant in the docs | append-only session JSONL | — | — |
| History | prefix-preserving compaction (drops the middle), replay from any event slice | append-only event log | summary compaction + session tree (`/tree`, `/fork`, `/clone`) | layered memory + compaction | the repo is the truth |
| Isolation | one git worktree per sub-agent | sandbox provider (Local/E2B/Remote) | via extensions | sub-agent isolation | worktree isolation |
| How changes land | hunk-by-hunk accept/reject; drifted hunks are reported, never mis-applied | — | `git` | `git` | `git` |
| Being integrated | ACP server — an editor can drive this harness | — | extension territory | native (the editor's agent) | IDE integration |
| Multi-agent | `single`/`parallel`/`chain`/`race`, context firewall + depth/concurrency/token/cost limits | a plugin | not in the core; extensions add it | sub-agents | — |
| Cost & cache | three dialects normalised, priced at cache rates, hit rate shown in the UI | telemetry seam | — | usage display | — |

---

## Kernel shape

The comparison above is about capabilities. This one is about the kernel: what the core is, who owns the loop, what an extension is, and what the event stream is for. It is the part that decides how much of the system you can read and replace.

| | micro-harness | pi | Codex | Claude Code | opencode |
|---|---|---|---|---|---|
| **Kernel** | ~12k lines of TypeScript in 4 packages; no runtime dependencies | a small TypeScript loop plus an extension API | a Rust workspace: `core`, `tui`, `exec`, `app-server`, sandbox crates | closed source | a TypeScript server plus a protocol package and several clients |
| **Owns the loop** | `Harness` (`packages/core/src/harness.ts`) | yes, deliberately small | `codex-core` | not inspectable | the server |
| **Unit of extension** | compile-time interfaces (`Provider`/`Tool`/`FileSystem`) + MCP read at boot | TypeScript extensions registered at startup | MCP, `AGENTS.md`, config | hooks, skills, sub-agents, MCP | plugins plus the server protocol |
| **Events** | one tagged stream: session log, SSE, replay, Trace and Inspector all consume it | session JSONL; RPC/SDK for integration | JSON-RPC (`app-server`) | — | the protocol between server and clients |
| **Boundary** | permission presets × approval × a per-tool `network` flag | defined by extensions | OS sandbox (Seatbelt/Landlock) + approval policy | permission modes | configuration |

Two honest notes. **opencode is the closest in shape**: a server that owns the loop, with TUI/desktop/web clients — the difference is scale and how small the kernel is, not the architecture. **pi is the closest in philosophy**: a small core with everything else as extensions; the difference is *when* extension happens — at startup through an API, or at compile time through interfaces.

What is not a difference: having a server with SSE (opencode), supporting MCP (Codex, Claude Code), or being extensible (pi). What is: a kernel you can read end to end (the seed is six files), a compile-time seam instead of a plugin runtime — so no hot-plug, by design — and one event stream that is simultaneously the log, the replay source and the UI feed.

## What we took from the field

Designs are not invented in a vacuum. Each item below credits its source and says where we used it.

**Event-driven loop (from dsh).** dsh makes every stage of the pipeline an observable event point. We converged on the same shape independently, and made it the load-bearing idea in the repo: one tagged `AgentEvent` stream, where every view is a pure function of a slice of it. The GUI's replay scrubber and agent tree are not features bolted onto the loop; they are two more consumers.

**The three-role capability seam (from dsh).** Its docs define a seam precisely: a replaceable capability with a Service Definition, a Service Provider and a Consumer. We applied it to the filesystem:

```
FileSystem (interface) → localFs | worktree | remote sandbox | in-memory test double
                                ↓
              read_file / write_file / list_dir (the tool surface the model sees)
```

The payoff is testable: `packages/core/test/fs.test.ts` runs the **real** `read_file`/`write_file`/`list_dir` on a pure in-memory filesystem, and sandboxing comes from the provider rather than the tools. "Worktree sub-agents" therefore became *swap the provider*, not a special case inside a tool.

**"Adapt it, don't fork it" (from pi).** pi's extension surface — tools, commands, event handlers, UI, npm packages — is the product. We adopted the goal and its honest constraint: pi achieves it with an API registered at startup, we with compile-time interfaces. Different cost structures, same promise.

**Compaction is lossy; keep the full record (from pi).** `/compact` summarises and says plainly that the full history stays in the JSONL. Ours is append-only too, and compaction **never rewrites what was already sent to the provider** — which is also why prompt cache keeps hitting.

**Worktree isolation (from Codex among others).** One working copy per agent, so parallel agents cannot overwrite each other.

---

## Deliberate trade-offs

### We built a DI container, measured it, and deleted it

P1 was a plugin kernel of our own: 396 lines and 10 tests — `provide`/`get`/`inject`, lifecycle, scopes, an event bus and config validation, deliberately Cordis-shaped to keep a migration path. Then we measured whether it carried weight:

| Measurement | Result |
|---|---|
| External references to `@micro-harness/kernel` | 1, and it was `import type` |
| Runtime consumers of the plugin objects and registry | 0 (each referenced only by its own tests) |
| Assembly sites in the repo | 25 |
| Of those, how many a new capability had to touch | 0 — every dependency is optional with a sane default |

A container buys exactly one thing: **runtime assembly**. The rest is derivative. And the honest answer to "will anyone add capability without recompiling?" was: not in our setting.

The usual counter-argument is MCP. But an MCP client is *read config at boot → connect → merge tools → close on exit*; ten lines in a constructor. A container only pays off once an MCP server must be **hot-swapped** and its tools withdrawn from a running agent. That is a real need — we just didn't have it.

So we kept the **seams**, deleted the **container**, and wrote the revival condition into the ROADMAP instead of leaving speculative code behind.

### We let the core own the loop

"No privileged core" is self-consistent for a runtime that must carry arbitrary models, loops and UIs. Our loop is 344 lines, and it is precisely the file we want read. Turning it into a plugin would hide it. That is a stated preference, not a verdict.

---

## Where we think we differ

1. **A readable seed, and a platform provably grown from it.** `seed-v1` is a tag on this repo: 17 files, zero dependencies, no build step, `node src/cli.ts "…"` runs. `main` is its direct descendant (the seed's files moved into `packages/core` at P0, still the same six source files).

2. **"Model-visible means recorded" as something you can open, not a sentence in a doc.** Every model call emits `model.request` with the exact payload — system prompt, tool schemas, the trimmed message array, and the harness's own token estimate. It is deliberately kept out of the search index so context dumps don't pollute `/api/search`; the GUI's **Inspector** renders it turn by turn. Its twin is replay: the whole view can be rebuilt from any slice of the event stream.

3. **Hunk-by-hunk review that never silently mis-applies.** Isolation gives each agent its own worktree; **review is the more interesting half**. `packages/core/src/patch.ts` parses a unified diff into globally numbered hunks and replays only the **accepted** ones onto the file's **current** content; a hunk whose old side no longer matches comes back `conflicted` and untouched — it refuses rather than guesses. Verified against real `git diff` output: new files, deletions, multi-file diffs, context drift.

4. **Economics as a first-class concern.** Three vendors report prompt-cache hits under three different field names; we normalise them into `usage.cacheRead`, price them at cache rates and show the hit rate in the UI. Two companion decisions make caching actually work: tool results are truncated **on write** (never rewritten later), and compaction drops the **middle** rather than the front. Measured on real runs in this repo: 75% / 78% / 69%.

5. **Web access as a first-party MCP server, not a built-in tool.** `MICRO_WEB` adds a bundled MCP server exposing `web_search` and `web_fetch`; the loop, tool registry and event contract do not know it exists. The same permission presets that gate the shell gate the network, and a runtime file (the GUI's 🌐 button) turns it off live without a restart. The fetcher is SSRF-guarded: it resolves the host, refuses non-public addresses, and pins the validated IP for the connection.

---

## What we are unsure about

| Question | What would answer it |
|---|---|
| Can compile-time seams serve a real "add capability without touching code" need? | Partly answered: for our setting, yes. MCP is *read config at boot* — one `connectMcpServers()` in `main.ts`, with zero changes to the loop, tool registry, event contract or GUI; verified against the reference server (13 tools, model called `everything__get-sum` and answered `42`). If hot-swapping is ever needed, the revival condition is in the ROADMAP. |
| Is deterministic "drop the middle" better than summarising old turns? | Measured, with an ablation: both preserve a constraint planted early in a long session, while dropping the front loses it. `summarize` costs about the same but peaks higher; we keep deterministic `drop-middle` as the default and offer `--compact=summarize` when semantics matter more than tokens. |
| Does the frozen seed hold up as the platform grows? | Whether a newcomer can still read `seed-v1` in one sitting **and** recognise today's platform in it. If the two drift apart, the tag is only archaeology. |
| Is hunk-level review worth its surface area (versus just reading `git diff`)? | Usage. This is the feature we are least sure is worth it. |

---

## Sources

- **DeepSeek Harness (dsh)**: its `architecture.md` (everything is a plugin; no privileged core to patch; the turn-flow event pipeline; the three roles of a capability seam; "model-visible means recorded"; append-only session event log).
- **pi**: its README and docs (Extensions, Compaction, Branching).
- **Codex**: [`openai/codex`](https://github.com/openai/codex) (Apache-2.0, an open-source CLI); the `codex-rs` workspace (core, tui, exec, app-server, sandbox crates).
- **opencode**: [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (open source, TypeScript monorepo: server, protocol, clients) and [opencode.ai](https://opencode.ai).
- **Claude Code**: public docs on hooks, sub-agents, and its memory/compaction model.
- **Our own claims**: every item under "Where we think we differ" can be checked in this repo — `packages/core/src/{harness,patch,context,fs}.ts`, `packages/gui/src/`, and the test suite (`bun test`).

> Snapshot date: 2026-10-17.
