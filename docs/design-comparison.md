# How micro-harness differs from other harnesses

> **The one-sentence version:** we are not the most capable harness. We are the one you
> can read end to end in one sitting — and then watch grow into a platform without the
> readable core being thrown away.

This is a design comparison, not a benchmarks page. Where it describes someone else's
harness it cites their public documentation (see [Sources](#sources)); where it
describes ours it points at code you can open right now.

---

## The five axes that actually distinguish harnesses

Feature lists make every harness look the same. These five questions separate designs:

| # | The question | Why it decides things |
|---|---|---|
| 1 | **Does the core own capabilities?** | If the agent loop itself is replaceable, you are building a *runtime*. If not, you are building an *application*. |
| 2 | **What is the unit of extension, and when does it load?** | A DI container, a registration API, and a constructor call are three different products with three different costs. |
| 3 | **What are events *for*?** | A debug log, an observability contract, or the extension surface itself. |
| 4 | **How is history managed?** | Compaction, branching, replay — and whether the full record survives what the model actually saw. |
| 5 | **How does generated code land?** | Sandbox or worktree, and who decides what gets applied. |

---

## Side by side

| | **micro-harness** | **DeepSeek Harness** (dsh) | **pi** | **Claude Code** | **Codex** |
|---|---|---|---|---|---|
| Shape | platform in a monorepo, plus a frozen readable seed | standalone runtime | minimal terminal harness | product | product |
| **Core owns capabilities?** | **Yes.** `Harness` owns the loop and the tools. | **No.** "Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself"; "there is no privileged core to patch". | Mostly: a small core with a large extension surface. | *n/a (closed)* | *n/a (closed)* |
| **Extension unit / load time** | **Compile-time seams** — `Provider`, `Tool`, `FileSystem`, `AgentRole` | Cordis plugins, at runtime | TypeScript extensions registered at startup (`registerTool`, `on(...)`), shipped as npm/git packages | hooks | `AGENTS.md` + repository conventions |
| **Events** | **The single contract.** CLI, GUI, trace, replay, agent tree and Inspector are all consumers of one tagged stream. | Event pipeline with plugin-visible extension points (`turn/*`, `step/*`, `agent/request`, `llm/stream`, `tools/*`) | RPC + SDK + JSON output | hooks | — |
| **"Model-visible means logged"** | **Implemented**: a `model.request` event carries the exact payload per turn (system prompt, tool schemas, messages, token estimate). | Stated architectural invariant. | Append-only session JSONL. | — | — |
| **History** | Prefix-preserving compaction (drop the *middle*), replay from any event slice | Append-only session event log | Summarize-based compaction (`/compact`), session **tree** (`/tree`, `/fork`, `/clone`) | Four-layer memory, five-level compaction | Repository as source of truth |
| **Isolation** | Git worktree per sub-agent | Sandbox providers (Local FS / E2B / Remote) behind a seam | Via extensions (SSH, sandboxes) | Sub-agent isolation | Worktree isolation |
| **Applying results** | **Hunk-level accept/reject**; a drifted hunk is reported, never mis-applied | — | `git` | `git` | `git` |
| **Multi-agent** | **First-class**: `single`/`parallel`/`chain`/`race`, context firewall, depth/concurrency/token/cost limits | A plugin | **Deliberately absent** — "ships with powerful defaults but skips features like sub agents"; you add them in an extension | Sub-agents | — |
| **Cost & cache accounting** | Cache reads normalized across providers, priced at the cached rate, surfaced as a hit rate | Telemetry seam | — | Usage display | — |

A `—` means the public documentation I read does not state it. That is not a claim that
the feature is absent.

---

## What we took, and from whom

**From dsh — the event pipeline.** dsh treats every stage as an event point plugins can
observe. We arrived at the same shape independently and it is now the load-bearing idea
in our repo: one tagged `AgentEvent` stream, and every view is a pure function of a
slice of it. The GUI's replay scrubber and the agent tree are not features bolted onto
the loop; they are two more consumers.

**From dsh — capability seams.** Their formulation is precise and worth repeating: a
seam is *a swappable capability with three roles — a Service Definition declaring the
interface, a Service Provider implementing it, and a Consumer using it, commonly a
model-facing tool*. We adopted it literally for the filesystem:

```
FileSystem (interface)  →  localFs | worktree | remote sandbox | in-memory test double
                                    ↓
                    read_file / write_file / list_dir   (the tool surface the model sees)
```

The payoff is testable: `packages/core/test/fs.test.ts` runs the **real** `read_file`,
`write_file` and `list_dir` tools against an in-memory filesystem with no disk at all,
and the sandbox rule keeps coming from the provider rather than the tool. A worktree
sub-agent is now a *provider swap*, not a special case in the tools.

**From pi — "adapt it, don't fork it".** pi's stated goal is to be extended without
patching its internals, and its extension surface (tools, commands, event handlers, UI,
npm packages) is the product. We took the goal, and the honest version of the
constraint: pi achieves it with a registration API loaded at startup; we achieve it with
interfaces you compile against. Different cost profiles, same promise.

**From pi — compaction is lossy, keep the full record.** `/compact` summarizes and is
explicit that "the full history remains in the JSONL file". Our JSONL is append-only
too, and compaction never rewrites what a provider has already been sent — that is also
what keeps the prompt cache valid.

**From Codex — worktree isolation.** One working copy per agent, so parallel agents
cannot overwrite each other.

---

## What we deliberately did not take

### A DI container — we built one, measured it, and deleted it

P1 was a self-built plugin kernel: **396 lines of code and 10 tests** — `provide` /
`get` / `inject`, a lifecycle (`waiting → active → failed`), scopes with `fork()` and
`isolate()`, an event bus, and config-schema validation. It was Cordis-shaped on
purpose, to keep a migration path open.

Then we measured whether it was load-bearing:

| Measurement | Result |
|---|---|
| External references to `@micro-harness/kernel` | **1**, and it was `import type` |
| Runtime consumers of the plugin objects and registries | **0** (each was referenced only by its own test) |
| Assembly sites in the repo | **25** (`new Harness(` ×14, `new AgentRunner(` ×4, `createServer(` ×7) |
| Edits those 25 sites needed when a new capability was added | **0** — because every dependency is optional with a sensible default |

A container buys exactly one thing: **runtime composition** — capabilities that appear
and disappear while the process is alive, so that adding one is a config change instead
of a code change. Every other benefit is downstream of that. Our honest answer to
"would anyone add a capability without recompiling?" was no.

The usual counter-argument is MCP. But an MCP client is *read the config at boot, connect,
merge the tool list, close on exit* — a constructor handles that in ten lines. If MCP
servers had to be hot-pluggable, with a dropped server withdrawing its tools from a
running agent, the container would earn its keep. That is a real requirement, and we
did not have it.

So we kept the **seams** and dropped the **container**, and wrote the trigger condition
into the ROADMAP rather than keeping speculative code: *if capabilities must come and go
at runtime, restore commit `5df4ba9` and rewrite the kernel against that requirement
instead of against an imagined one.*

### A core that owns nothing

dsh's "there is no privileged core to patch" is coherent for a runtime that must host
arbitrary models, loops and UIs. Our loop is 268 lines and it is the thing people come
to read. Making it a plugin would hide the one file we most want visible.

---

## What is ours

1. **A readable seed, and the platform that grew out of it — provably not forked.**
   `seed-v1` is a tag on this repo: 17 files, zero dependencies, no build step,
   `node src/cli.ts "…"` works. `main` is a strict descendant of it (the seed's files
   were *moved* into `packages/core` in P0, and are still the same four modules). Nothing
   else in this comparison offers "read the whole harness in one sitting" **and** "the
   same code is the floor of a running platform".

2. **"Model-visible means logged" as a feature you can open, not an invariant on paper.**
   dsh states the rule; we implement it as a first-class event. Every model call emits
   `model.request` with the exact payload — system prompt, tool schemas, the message
   array *after* trimming, and the harness's own token estimate. It is deliberately
   excluded from the search index so context dumps never pollute `/api/search`, and the
   GUI's **Inspector** tab renders it per turn. Its sibling is replay: the whole view can
   be rebuilt from any slice of the stream.

3. **Hunk-level review that cannot silently mis-apply.** Isolation gives each agent a
   worktree; the review step is the more interesting half. `packages/core/src/patch.ts`
   parses a unified diff into globally-numbered hunks and replays **only the accepted
   ones** onto the file's *current* content. A hunk whose old side no longer matches
   comes back as `conflicted` and is left untouched — it refuses rather than guesses —
   and the result is written through the same integrate path as a full promote, so
   backups and conflict reporting come for free. Verified against real `git diff` output
   for new files, deleted files, multi-file diffs and drifted context.

4. **Seams, not a container — with the receipt.** The deleted kernel is documented above
   with numbers, and the trigger that would bring it back. Most projects ship the
   speculative abstraction and never revisit it; we published the measurement and the
   reversal.

5. **Economics as a first-class concern.** Providers report prompt-cache hits under
   three different names; they are normalized into `usage.cacheRead`, priced at the
   cached rate, and surfaced in the UI as a hit rate. Two related decisions make the
   cache actually hit: a tool result is capped **when it is appended** (never rewritten
   later), and compaction drops the **middle** rather than the front, so the head stays a
   stable prefix. Measured on real runs in this repo: **75% / 78% / 69%** hit rate across
   three calls, with cache-aware accounting coming out **~2× cheaper** than the naive
   "every input token is a miss" calculation it replaced.

---

## Open questions

We would rather write down what we are unsure about than imply we are not.

| Question | What would settle it |
|---|---|
| Do compile-time seams satisfy a real third party who wants to add a capability without forking? | The MCP round. If "just read the config" holds, containers stay unnecessary *for us*; if someone needs to add a capability to a running process, the kernel comes back. |
| Is "drop the middle deterministically" better than "summarize the old turns"? | An eval suite. Ours is testable and cache-friendly; summarization may preserve more meaning at the cost of a model call and a non-deterministic transcript. We cannot claim a winner without measuring. |
| Does a frozen seed keep its value as the platform grows? | Can a newcomer still read `seed-v1` in one sitting *and* recognise the platform in it? If those drift apart, the tag becomes archaeology. |
| Is hunk-level review worth the surface area versus "just review the diff in git"? | Usage. It is the feature we are least sure is worth its weight. |

---

## Sources

- **DeepSeek Harness** (`dsh`, developer preview 2026): its `architecture.md` — "every
  part of the product is a plugin", "there is no privileged core to patch", the turn-flow
  event pipeline, the three roles of capability seams, "model-visible means logged", and
  the append-only session event log. Summarized in
  [`learn-harness-engineering` → DeepSeek breakdown](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/harness-designs/deepseek/index.md)
- **pi**: its own README and docs (`Extensions`, `Compaction`, `Branching` sections).
- **Claude Code / Codex**: as summarized in
  [`learn-harness-engineering`](https://github.com/walkinglabs/learn-harness-engineering)
  (four-layer memory, five-level compaction, hooks, sub-agent isolation; repository as
  source of truth, `AGENTS.md`, worktree isolation).
- **Our own claims**: everything in the *What is ours* section is checkable in this repo —
  `packages/core/src/{patch,context,fs,harness}.ts`, `packages/gui/src/`, and the test
  suite (`bun test`).
