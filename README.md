# micro-harness

**A minimal, dependency-free agent harness** — the agent loop, tool dispatch and
context windowing, in a few hundred lines of TypeScript. No SDK, no framework, no
build step: Node ≥ 22.18 runs the `.ts` files directly.

**English** · [简体中文](README.zh-CN.md)

> An **agent harness** is the runtime that wraps an LLM and turns it into an
> agent: it runs the loop, executes tools, manages the context window and talks to
> the model. This repo is a clear, readable implementation of exactly those four
> pieces — nothing more.

```
        ┌──────────────────────────────────────────────────────┐
        │                      harness                         │
        │                                                      │
 user ──┼──▶ messages ──▶ model.chat() ──▶ tool_calls? ──┐     │
        │                     ▲                          │     │
        │                     │                          ▼     │
        │              append tool result ◀── tool dispatch ───┼──▶ read_file / write_file / list_dir / bash
        │                     │                                │
        │              context.trim() when the window fills    │
        └──────────────────────────────────────────────────────┘
```

## Run it

```bash
export MICRO_BASE_URL=https://api.deepseek.com     # any OpenAI-compatible endpoint
export MICRO_API_KEY=sk-...
export MICRO_MODEL=deepseek-chat

node src/cli.ts "Create hello.txt with 'hi', then read it back and print the contents"
node src/cli.ts               # interactive REPL (keeps context between turns)
node src/cli.ts --allow-bash "Find the 3 largest files and summarise them"
node src/cli.ts --trace "…"   # write a JSONL transcript to ./traces/
```

| flag | meaning |
|---|---|
| `--dir <path>` | working directory the tools are sandboxed to (default `.`) |
| `--model <id>` / `--base-url <url>` | override the env config |
| `--allow-bash` | enable the `bash` tool (off by default) |
| `--max-steps <n>` | loop iterations before giving up (default 24) |
| `--max-context <n>` | context budget in estimated tokens (default 24000) |
| `--trace` | append every event to a JSONL transcript |
| `--quiet` | don't print tool activity |

## The four pieces

| file | what it is |
|---|---|
| `src/harness.ts` | **the loop** — model → tools → feed results back → repeat, with a step limit |
| `src/tools.ts` | **tool registry + dispatch** — `read_file`, `write_file`, `list_dir`, `bash`; path-sandboxed; tool errors become messages the model can recover from |
| `src/context.ts` | **context windowing** — token estimate + trimming that keeps the system prompt and whole turns, never orphaning a tool result from its call |
| `src/model.ts` | **model I/O** — an OpenAI-compatible `chat/completions` call with retries on 429/5xx |

Plus a tiny `src/trace.ts` (JSONL transcripts) and `src/cli.ts` (one-shot + REPL).

## Design notes

- **Zero runtime dependencies.** Only Node built-ins (`node:child_process`,
  `node:fs`, `fetch`). There is no `npm install` step to run it.
- **No build step.** Node's type stripping runs the TypeScript directly.
- **Errors are data.** A failed tool returns `{ output, isError: true }` which is
  appended as a normal `tool` message — the model sees the failure and can retry,
  which is what makes an agent loop robust.
- **Sandboxing.** File tools resolve every path inside `--dir` and refuse
  traversal; `bash` is opt-in.
- **Trimming keeps turns intact.** A `tool` message is only ever kept together
  with the assistant `tool_calls` that produced it.
- **Observability is built in.** The loop emits structured events
  (`step`, `tool_call`, `tool_result`, `trim`, `usage`); the CLI renders them and
  `--trace` persists them.

## Tests

```bash
bun install
bun test          # unit suite: kernel, core, server, gui derivation
bun run verify    # P3/P4/P5 feature checks (scripted provider, no network)
bun run typecheck
```

## Packages

- `packages/kernel` — plugin kernel: services/DI, lifecycle, scopes, events
- `packages/core` — agent loop, tools, context, providers, multi-agent, sessions, CLI
- `packages/server` — HTTP + SSE + SQLite/FTS index
- `packages/gui` — React web UI

## GUI

A React 19 + Vite + Tailwind front end (design tokens shared with PiStudio): a
session list, a streaming transcript with tool cards, a **multi-agent tree** with
per-agent tokens/cost, a **trace panel with a replay scrubber** that rebuilds the
conversation from a slice of the event stream, and a **changes panel** (per-agent
diff / promote + an integrate-all **merge queue**) when the server runs with
`MICRO_ISOLATE=1`.

![GUI](docs/gui.png)

With isolation on, each sub-agent gets its own git worktree, so parallel agents
never overwrite each other:

![merge queue](docs/gui-changes.png)

Because an agent's output is a diff, the changes panel lets you review it **hunk by
hunk** and apply exactly the parts you want (`packages/core/src/patch.ts` parses the
diff and replays only the accepted hunks; `POST …/agents/:id/apply` writes them
through the same integrate/apply path, so backups and conflict reporting come for
free). A hunk whose context has already drifted is reported, never mis-applied:

![hunk-level review](docs/gui-hunks.png)

The UI is bilingual — **English / 简体中文** — switched in place with the `中 / EN`
button (it follows the browser language on first visit):

![GUI in Simplified Chinese](docs/gui-zh.png)

```bash
# one command — starts the server and the GUI, and picks up an API key
scripts/dev.sh                 # → http://127.0.0.1:5273

# or run the two halves yourself:
MICRO_API_KEY=… bun packages/server/src/main.ts          # terminal 1
cd packages/gui && MICRO_SERVER=http://127.0.0.1:8787 bun run dev   # terminal 2
```

The server reads `MICRO_MODEL` (use the provider's real model id, e.g.
`deepseek-chat`), `MICRO_BASE_URL`, `MICRO_API_KEY`, `MICRO_DATA_DIR` and
`MICRO_MODELS`. `dev.sh` prints which key it picked up — `key sk-41cdf912… (from
~/.pi/agent/auth.json)` — and warns when an exported key silently shadows a different
one in `auth.json`, which is otherwise a confusing "why is my balance zero" 402.

The transcript renders **Markdown with syntax-highlighted code** (a dependency-free
renderer ported from PiStudio), and **⌘K** opens a command palette that also does
full-text search across every saved session (`/api/search`, FTS5):

![command palette](docs/gui-palette.png)

The right panel has three views. **agents** draws the sub-agent tree with per-node
usage (hover a node for its detail card), and **trace** is the raw event stream with
category chips, a text filter and a replay scrubber:

![trace panel](docs/gui-trace.png)

Everything the GUI renders is derived from the event stream by pure functions in
`packages/gui/src/lib/derive.ts` (unit-tested).

The details that make it feel like a real coding tool: live usage is a **rolling
number next to an inline sparkline** of tokens per model call; the agent tree draws
real connectors and shows a detail card on hover; the changes panel renders a
**colored diff with an old/new line-number gutter**; sessions are grouped into
**Today / Yesterday / Earlier** with hover-to-delete; the transcript only auto-follows
while you are parked at the bottom (scroll up and it freezes, surfacing a "back to
bottom" pill); and scrubbing the trace desaturates the whole view into **REPLAY** mode.

### Keyboard

| key | action |
|---|---|
| `⌘K` / `Ctrl K` | command palette — app actions + full-text session search |
| `⌘/` | keyboard cheat sheet |
| `↑` `↓` | move through the sidebar or the palette |
| `Enter` | send the prompt |
| `⇧ Enter` | newline in the prompt |
| `Esc` | close any dialog |

The palette also exports the current session as Markdown and copies the raw trace as
JSON. A desktop notification fires when a run finishes while the tab is hidden.

Sessions can be **renamed inline** (hover a row) or deleted, and the transcript is
editable: hovering a user message offers **edit & resend**, which forks the session
truncated to just before that message and runs the edited prompt in the fork — the
original session is left untouched. The composer's **model picker** is fed by
`GET /api/models`, so `MICRO_MODELS=model-a,model-b scripts/dev.sh` advertises
several.

## Two layers in one repo

`main` is the **minimal seed**: everything under `src/` is a dependency-free harness
you can read end to end — the loop, tool dispatch, context windowing and model I/O —
run directly by Node ≥ 22.18.

This **`platform`** branch grows that seed into a full **agent platform** under
`packages/`: a plugin kernel, an event-driven core with streaming and parallel tool
calls, first-class multi-agent orchestration, a server with SSE + a SQLite/FTS index,
a CLI, and the web GUI above. The seed in `src/` is left intact as the readable
reference — the platform was built on the same design rather than forking it.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the design of the full harness
platform — plugin kernel, composition, server, GUI, MCP/ACP — and
**[ROADMAP.md](ROADMAP.md)** for the long-term plan.

## License

MIT
