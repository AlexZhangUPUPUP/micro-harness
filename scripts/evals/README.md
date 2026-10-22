# Evals (P10)

Context retention, corrections, progress and checkpoint recovery have a separate
[specialized evaluation](context/README.md), with paired full-history/drop-middle/summarize runs.

A minimal but honest eval harness: **"did the agent actually do the task?"**

Every task is a small, self-contained coding job. Most tasks have a *deterministic*
grader — file contents/existence, a regex over the final answer, or the exit code of a
shell command in the sandbox (e.g. `bun test`). Some tasks also (or instead) carry a
`rubric` for the LLM judge, for work whose quality has no single right answer; see
"The LLM judge" below.

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

The task set (26 tasks) covers: exact file content, fixing a failing test, renaming a
symbol across files, producing a JSON file with a specific shape, surgical edits,
reading-then-writing, deleting files, fixing package scripts, extracting a constant,
fixing an off-by-one caught by a test, adding a test that must pass, making a script
idempotent, refactoring/splitting code under a behaviour-preserving test, explaining
a bug, designing a small API, documenting a module, adding validation, choosing an
idiomatic approach, writing a commit message, and reviewing a diff for risks. Several
tasks require reading a file first; several require `bash`.

## What it deliberately does *not*

- **No independent human labels.** The judge's golden labels (see "How much can we
  trust the judge?") are maintainer-written, so they measure agreement with our own
  documented standard — not ground truth.
- **Modest task set.** 26 tasks — enough to smoke-test a harness and grade the judge,
  not to rank models.
- **No statistical power.** A few runs per task can show flakiness, not significance.
- **No live-answer capture beyond one turn.** It grades the workspace, not style.
- **No release/package steps** — that part of P10 is out of scope here.

Sibling note: `bunx tsc --noEmit` at the repo root only covers `packages/*`; this
directory type-checks on its own via
`bunx tsc -p scripts/evals/tsconfig.json --noEmit` (see that file).

## A lesson this suite learned the hard way

The first version of our long-session ablation (a task that plants an unguessable rule and
then floods the context) **passed when it should have failed**: the prompt said "read
`bulk-N.txt` and reply with its first line", and the model cheerfully called
`read_file` with `offset: 1, limit: 1` — so the 8 KB file never entered the context, no
compaction ran, and the control looked fine.

The fix had nothing to do with compaction: make the stimulus **unavoidable** (one very
long line instead of 90 short ones), so that any legitimate way of doing the task puts
the bulk in the window. The general rule:

> A grader must not depend on the model's incidental choices. If the model can satisfy
> your instructions without exercising the thing you are testing, your test measures
> nothing — and it will pass.

## The LLM judge

Some work has no single right answer — is this refactor readable? is that error handling
honest? A deterministic check can only test a few sample inputs, so `rubric` tasks add an
**LLM judge**: a strict, rubric-bound reviewer that must answer with JSON
(`{verdict, score, reasons, violations}`; anything unparseable is an **error**, never a
pass).

Guardrails, because "call a model and believe it" is not a grader:

- the rubric is the only standard; the judge is told not to reward verbosity or flattery
  and that a missing requirement is a `fail`;
- the prompt **never names the harness, config or model** that produced the work, so it
  cannot play favourites;
- `judge model != agent model` is reported, because a model grading its own output is a
  known bias;
- **calibration is printed on every run**: for tasks that have both a deterministic check
  and a rubric, the judge's verdict is compared against the check, and every disagreement
  is listed. That is not a judge-accuracy number — it is a **disagreement detector**: when
  the two disagree, one of them is wrong and you have to look.

### It earned its keep immediately

On the first real run (5 tasks, real DeepSeek, judge = `deepseek-reasoner`) the judge
disagreed with the checks twice, and investigation showed **the judge was right**:

`add-validation` asked the agent to make a config parser throw descriptive errors. The
check verified `port=abc` and a missing `host` — and passed. The judge failed it (score
2.0) and quoted the cause: a line without `=` still reached `value.trim()` and leaked a
bare `TypeError`.

Two rounds of "hardening" the check then failed to catch it, the second one instructively:
it matched on the *error message*, and the message is **engine-specific** — V8 says
`Cannot read properties of undefined (reading 'trim')`, Bun (JavaScriptCore) says
`undefined is not an object (evaluating 'value.trim')`. A grader that matches on wording
silently passes the bug on a different runtime.

The final check asserts on **semantics** instead — a leaked `TypeError` is a failure — and
now discriminates in both directions (half-fixed code fails, properly fixed code passes).
Three iterations of a deterministic grader missed this defect; the judge found it by
reading the code. That is the case for having one.

### What it costs, honestly

| | agent | judge |
|---|---|---|
| cost on that 5-task batch | $0.0103 | $0.0113 |
| model | `deepseek-chat` | `deepseek-reasoner` |

The judge roughly doubles the cost of a run, and it is **stricter** than the checks
(score 2.0 on code the check called fine) — which is useful for finding weak graders but
would be unfair as a sole gate without calibration. The calibration set is now 6
`both` tasks, and a 10-case golden set (`golden.ts`) drives `calibrate.ts` — see below.
`--judge-runs=N` exists to check self-consistency but is not free.

## How much can we trust the judge?

`scripts/evals/calibrate.ts` measures the judge against `scripts/evals/golden.ts` — a
labelled set of finished agent outputs (one clearly-good and one clearly-bad answer per
covered task). Read the caveats before quoting the number:

- **The labels are maintainer-written, not independent human labels.** Each label's
  `rationale` is the evidence for it, so a careful reviewer can check our reasoning, but
  the accuracy number still measures *agreement with our own documented standard*, not
  ground truth. A high score means the judge enforces the rubric we wrote; it does not
  prove the rubric matches what real users want.
- **A miss is either a judge bug or a bad label.** On every miss, `calibrate.ts` prints
  the judge's own `reasons`/`violations` next to the case's `rationale` so the reader can
  tell which one was wrong.

Run it in both modes:

```sh
export PATH="$HOME/.bun/bin:$PATH"

# offline, deterministic — CI-safe, no network, no API key
bun scripts/evals/calibrate.ts --mock
# real judge
MICRO_API_KEY=… bun scripts/evals/calibrate.ts --judge-model=deepseek-reasoner
```

Flags: `--runs=N` asks the judge N times per case and reports self-consistency,
`--json=<path>` writes the report, and `--min-accuracy=<0..1>` (default `0.8`) is the
exit-code gate — `0` when accuracy is at or above it, non-zero otherwise.

**What `--mock` does and does not prove:** in mock mode the scripted judge constructs its
verdict *from the case's label*, then still builds the real prompt and re-parses its
verdict through the strict parser. So a mock run proves the prompt-build → judge → parse
→ compare → exit-code plumbing works, and it produces a meaningful exit code — but its
100% accuracy says **nothing** about real judge quality. Never cite a mock run as evidence
about judge accuracy; only a real-judge run is evidence (and even that is evidence of
agreement with our labels, not ground truth).

Current gate: accuracy ≥ **0.8** against the golden set (10 cases over 5 tasks).

