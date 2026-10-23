# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

当前未发布的 v0.2.2 候选内容：

### Added

- Context Inspector：每次模型调用记录可回放的上下文快照，压缩记录前后窗口、删除/摘要数量与降级原因；Server 提供 Context 查询和 Markdown 导出，GUI 增加实时 Context 面板。

- v0.3 第一条纵向切片：新增结构化任务状态（目标、状态、步骤、约束、验证、阻塞项），提供 `GET/POST /api/sessions/:id/task`，并通过 `task.update` 事件持久化和实时广播。
- GUI 新增任务状态面板，从同一事件流展示任务目标、步骤、约束、验证结果和修订版本。
- 存储层将 SQLite 提升为会话元数据和事件的事务事实来源，JSONL 保留为可读兼容导出，并新增从 SQLite 修复导出的接口。
- 新增离线 `micro-harness-storage migrate/export/restore` 命令，支持旧 JSONL 导入、版本化备份和空目录恢复。
- 第一波运行可靠性：增加共享 RunBudget（成本/Token）、父子 Agent 取消传播、任务运行生命周期和等待验证状态；GUI 只有在验证全部通过后提供显式完成操作。
- 工具调用新增结构化状态事件，覆盖审批、启动、成功、失败、取消和副作用未知状态。
- 运行取消会释放 GUI 审批等待，工具卡片展示取消与未知状态。
- shell 和 MCP 工具调用会接收运行取消信号，避免取消后继续等待底层请求。
- SSE 支持会话级 `Last-Event-ID` 增量恢复，断线重连无需重复加载完整历史。
- SQLite 新增工具执行账本，按会话、Agent 和调用 ID 记录状态、原因与结果摘要。
- 新增会话级 ArtifactStore，产物内容原子落盘、SHA-256 校验，并提供列表、下载和删除 API。
- `/health` 增加 readiness、SQLite schema/会话/事件统计和活动运行数，便于部署诊断。
- Provider 增加可选能力声明，并通过独立 `/api/provider` 暴露，保持原 `/api/models` 响应兼容。
- `resume` 支持持久化 `Idempotency-Key`，客户端重试不会重复启动同一会话运行。
- MCP HTTP 调用把取消信号传递到底层 fetch，stdio 调用发送 `$/cancelRequest` 通知。
- Unix shell 工具使用独立进程组，取消时终止整个受管理进程树。
- 恢复时读取执行账本，对历史 unknown 工具调用默认阻止自动重放并要求人工核查。
- 服务停止只清理取消/失败运行的临时 worktree，成功运行的 reviewable 产物继续保留。
- 新增只读 worktree 生命周期扫描，可区分 clean、dirty、missing 和 unknown，便于恢复前人工审查遗留工作区。
- 新增有界 `search` 工具，支持 glob、结果上限和取消信号，为代码理解与验证闭环提供稳定搜索入口。
- 新增结构化 `verify` 工具，记录命令、退出码和截断输出，供实现后的确定性验证与诊断使用。
- Artifact 下载支持单段 HTTP Range，长产物可分段读取并继续校验 SHA-256。
- 会话新增验证接口，在权限允许时执行有界命令并把退出码、诊断输出写入任务验证状态。
- SSE 慢消费者达到有界积压后主动断开，客户端可使用最后事件游标续传，避免服务端无限积压内存。
- Session 事件查询支持 `after`/`limit` 分页和 `next` 游标，大历史加载不再强制返回完整事件流。
- MCP stdio 配置支持取消时终止独立进程组，避免不可安全重用的长调用在取消后继续执行。
- MCP 连接增加显式 `reconnect()`，重新初始化并协商工具列表，不复用断开连接的未知状态。
- Agent 契约支持父任务执行确定性 checks，并把每项命令输出与 passed/failed 状态返回给父任务。
- GUI 任务状态增加追加式投影，实时事件只处理新增部分，回放或切换会话时自动重置。
- Agent 契约验收增加产物存在性检查，缺失产物会明确使契约失败。
- CI 与 Release 固定 Bun 1.4.3、使用冻结 lockfile，并新增支持矩阵文档。
- 并行工具调用对 mutating 工具增加执行锁，避免写入和外部副作用重叠；只读工具仍保持并行。
- Provider 明确声明不支持流式、工具、图像或取消时，Harness 会在请求前拒绝并返回可诊断错误。
- Server 启动会扫描遗留 active 会话，写入 `server_restarted` 诊断错误并保留 resume 恢复入口。
- CI 主测试改为 Ubuntu 与 macOS 双平台矩阵，分别验证测试、类型、文档和 GUI 构建。
- `bun run verify` 扩展为第二至第四波纵向回归门，覆盖 Provider、任务验证、事件分页、Artifact Range、SSE 和 MCP 重连。
- Server 新增只读 `/api/sessions/:id/worktrees`，向 GUI/审查流程暴露 worktree 生命周期状态。
- Artifact 创建和删除现在写入统一事件流，可在 Trace、回放和审计中追溯。
- AgentResult 增加结构化终态，区分成功、普通失败、取消、超时和预算停止。
- task 委派支持目标、验收条件和预期产物契约，并明确标记未独立验证的结果。
- Context 增加独立的 `task/` 来源证据模块，按来源、顺序、工具调用 ID 和截断状态保存用户输入与工具观察。
- 摘要输入选择优先保留用户约束、途中纠正和不同的短工具观察，并把省略记录纳入预算。
- 检查点支持可选任务证据快照，兼容旧日志和 Agent 隔离恢复。
- 新增中文版本路线图，覆盖 core、server、GUI、协议、评测和发布门槛。

### Fixed

- 修复大历史会话的 SSE 回放被慢消费者保护提前截断，已完成会话会正确发送 `end`，GUI 不再把正常结束显示为 `event stream disconnected`；Context Inspector 改为展示压缩原因、token 前后变化、角色统计和可展开消息详情。

- 修复旧检查点恢复时已淘汰的用户消息可能重新变成最新证据的问题。
- 修复不同工具输出截断方式导致同一个工具调用被重复记录的问题。
- 修复上下文投影可能挤掉不可裁剪的最新用户输入的问题。

### Validation

- 新增结构化任务状态冲突与事件重建测试；TypeScript 类型检查和 GUI 生产构建通过。
- 原有 53 个上下文、恢复、Provider 和 Server 定向测试结果保持有效；真实模型结果和限制见 `specs/007-task-state/tasks.md`。

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
