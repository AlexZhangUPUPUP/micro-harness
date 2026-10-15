# Evals (P10)

A minimal but honest eval harness: **"did the agent actually do the task?"**

Every task is a small, self-contained coding job with a *deterministic* grader —
file contents/existence, a regex over the final answer, or the exit code of a shell
command in the sandbox (e.g. `bun test`). Nothing is judged by another model.

## Run it

```sh
export PATH="$HOME/.bun/bin:$PATH"

# scripted provider — no network, no API key, deterministic (CI-safe)
bun scripts/evals/run.ts --mock

# real provider (OpenAI-compatible; DeepSeek by default)
MICRO_API_KEY=… bun scripts/evals/run.ts
```

Exit code is `0` when every graded attempt passed, non-zero otherwise — so CI can
assert on it directly. `--mock` follows the same rule (it scripts hand-written tool
calls through the real harness loop, so it exercises everything but the model).

### Flags

| flag | meaning |
| --- | --- |
| `--mock` | scripted provider, no network |
| `--task=<id>` / `--tasks=a,b` | run a subset |
| `--runs=<N>` | runs per task (default 2, to expose flakiness) |
| `--max-steps=<N>` | model loop step budget (default 24) |
| `--json=<path>` | write JSON report (empty/`-` → stdout) |
| `--md=<path>` | write Markdown report |
| `--quiet` | no table, summary line only |

### Env

`MICRO_BASE_URL`, `MICRO_API_KEY` (or `OPENAI_API_KEY`), `MICRO_MODEL`
(default `deepseek-chat`). Cost comes from `MICRO_PRICE_INPUT` /
`MICRO_PRICE_OUTPUT` / `MICRO_PRICE_INPUT_CACHED` (all default `0`, so cost is
`$0` unless you set them).

## What it measures

Per attempt: `status` (pass/fail/error), `turns` (user turns), `steps` (`turn.start`
count — the model loop iterations), `toolCalls`, input/output/cacheRead tokens,
cost, wall-clock `ms`, and the truncated final answer. Tasks run in a fresh
`mkdtemp` sandbox each attempt; the system prompt is pi's own prompt with only the
name, tool list and docs section swapped (see `prompts/micro-harness.md`), so
results are comparable across harnesses.

The task set (8 tasks) covers: exact file content, fixing a failing test so
`bun test` passes, renaming a symbol across two files, producing a JSON file with a
specific shape, finding and changing one line, reading a file then writing its
contents, appending without breaking existing content, and making `bun run` print
the right thing. At least one task requires reading a file first; several require
`bash`.

## What it deliberately does *not*

- **No LLM-as-judge.** Graders are deterministic predicates only.
- **Tiny task set.** 8 tasks — enough to smoke-test a harness, not to rank models.
- **No statistical power.** A few runs per task can show flakiness, not significance.
- **No live-answer capture beyond one turn.** It grades the workspace, not style.
- **No release/package steps** — that part of P10 is out of scope here.

Sibling note: `bunx tsc --noEmit` at the repo root only covers `packages/*`; this
directory type-checks on its own via
`bunx tsc -p scripts/evals/tsconfig.json --noEmit` (see that file).
