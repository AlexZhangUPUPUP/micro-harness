# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

当前未发布的 v0.2.2 候选内容：

### Added

- Context 增加独立的 `task/` 来源证据模块，按来源、顺序、工具调用 ID 和截断状态保存用户输入与工具观察。
- 摘要输入选择优先保留用户约束、途中纠正和不同的短工具观察，并把省略记录纳入预算。
- 检查点支持可选任务证据快照，兼容旧日志和 Agent 隔离恢复。
- 新增中文版本路线图，覆盖 core、server、GUI、协议、评测和发布门槛。

### Fixed

- 修复旧检查点恢复时已淘汰的用户消息可能重新变成最新证据的问题。
- 修复不同工具输出截断方式导致同一个工具调用被重复记录的问题。
- 修复上下文投影可能挤掉不可裁剪的最新用户输入的问题。

### Validation

- 53 个上下文、恢复、Provider 和 Server 定向测试通过。
- TypeScript 与上下文 mock 评测通过；真实模型结果和限制见 `specs/007-task-state/tasks.md`。

### Release notes

- 以上内容尚未创建 v0.2.2 tag，也不代表完整任务状态、共享 Agent 预算或进程级恢复已经完成。

## [0.2.1] — 2026-10-21

### Added

- Sandbox secret hygiene: credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gh`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`) are hidden from
  sandboxed shells and secret-looking env vars are scrubbed; `--sandbox-secrets=allow`
  restores the previous behaviour.
- Approval cards render a line diff for `edit_file` / `write_file` (raw arguments
  stay one click away), so a write can be judged before it happens.
- Usage: per-call latency and a context-vs-budget bar; `/api/limits` exposes the
  configured context budget.

## [0.2.0] — 2026-10-19

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

[0.2.1]: https://github.com/AlexZhangUPUPUP/micro-harness/releases/tag/v0.2.1
[0.2.0]: https://github.com/AlexZhangUPUPUP/micro-harness/releases/tag/v0.2.0
[0.1.0]: https://github.com/AlexZhangUPUPUP/micro-harness/releases/tag/v0.1.0
