# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Usage panel redesigned around **model calls**: stacked bars per call (uncached /
  cached / output), a sortable call table linked to the chart, agent/model
  filters, a context estimate kept separate from cumulative usage, and honest
  "prices not configured" / "lower bound" states instead of `$0`.
- Usage accounting: a dated built-in price table (env overrides win), per-agent
  and per-model breakdowns, reasoning tokens, and per-point cache hit.
- Usage panel (click the token pill): time-based x-axis, new-vs-cached input,
  per-point tooltips, and cost shown as unknown (`—`) when prices are not
  configured instead of a misleading `$0`.
- First-party web tools are now built into the core instead of an auto-injected
  MCP server: same names (`web_search` / `web_fetch`), same runtime toggle, and
  they now work in the CLI and the compiled binary too, and `micro-harness mcp` exposes them to other agents only with `--allow-net`.
- Web search defaults to bing and falls back to it when the preferred engine is
  unconfigured; bocha / deepseek / baidu stay opt-in.
- `edit_file`: exact-string replacement that refuses a missing or ambiguous match,
  so a targeted change no longer rewrites the whole file. A batch (`edits: [...]`)
  is applied in order and atomically — if any edit fails, nothing is written.
- Optional OS sandbox for the shell tool (`--sandbox=auto|require`,
  `MICRO_SANDBOX`): Seatbelt on macOS, bubblewrap (`bwrap`) on Linux;
  deny-by-default writes outside the workspace, and no network unless
  `--sandbox-net` is passed.

## [0.1.0] — 2026-10-19

First public release: a coding-agent runtime you can read end to end.

### Added

- Agent loop with streaming tool calls, parallel execution, cancellation,
  context compaction (`drop-middle` / `tail` / `summarize`) and cost accounting.
- Multi-agent orchestration (`single` / `parallel` / `chain` / `race`), context
  isolation, optional git worktrees and hunk-level review.
- MCP client (stdio and HTTP), ACP server for editors (Zed and others), and
  `micro-harness mcp` to serve this harness's tools to other agents.
- HTTP/SSE server and React GUI: sessions, live transcript, approvals, model
  picker, per-session permissions, Trace/Replay/Inspector, English and Chinese.
- Permission presets (`read-only` / `workspace` / `full` / `auto-review`), a
  per-tool `network` capability, and approval routing through the GUI or CLI.
- Built-in web tools in a separate MCP server: SSRF-safe `web_fetch` and
  `web_search` with bing, baidu, bocha, deepseek and searxng backends, plus a
  runtime on/off switch and engine picker.
- Project instructions (`AGENTS.md`), skills (`skills/*/SKILL.md`) and prompt
  templates (`prompts/`, `commands/`), shared by the CLI and the web UI.
- Evals: 26 tasks, deterministic `--mock` mode, LLM judge, golden set and a
  calibration command.
- Documentation site generated from Markdown and published with GitHub Pages.
- Single-file binary (`bun build --compile`) and `scripts/install.sh`.

### Changed

- CLI defaults: the shell is enabled, approvals default to `auto-edit`, and
  `--no-bash` turns the shell off.
- The web launcher defaults to `full`; README examples use `auto-review`.
- Test suite: 212 tests.

### Fixed

- A prompt sent while a run is active now interrupts that run instead of
  producing history whose tool calls have no results (the provider returned
  HTTP 400).
- Event sequence numbers continue across resumes, so SSE clients no longer drop
  every event after the first turn.
- `allowBash` reaches the main harness (the `full` preset could not run the
  shell in the web UI).
- Symlinks that escape the working directory are rejected before any file
  operation.
- Re-fetching the same URL is served from a five-minute cache.

### Security

- SSRF-safe fetch: resolve the host, require public addresses, pin the
  validated IP, https only, same-host redirects only, with size and time caps.
- No OS-level sandbox yet; see the limitations section of the README.

[0.1.0]: https://github.com/AlexZhangUPUPUP/micro-harness/releases/tag/v0.1.0
