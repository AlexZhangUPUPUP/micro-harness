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

- 2026-10-16 · P8（部分）· **MCP client**：stdio + streamable HTTP（手写 JSON-RPC，不引 SDK）、`mcp.json` 启动时读取、`<server>__<tool>` 命名空间、`GET /api/mcp`、CLI 与 server 双端接线 · `bun test` 120/120；已对官方参考 server 端到端验证（13 工具 → 模型调用 `everything__get-sum` → 42），循环/注册表/事件/GUI 零改动

- 2026-10-16 · P8（完）· **ACP server**：协议 v1（JSON-RPC/NDJSON）；入 initialize/session/new/session/prompt/session/cancel，出 session/update（文本/工具/用量）+ session/request_permission + fs/*；`micro-harness acp`。审批接到编辑器 UI；客户端声明 fs 时文件系统换成 editor-backed provider · `bun test` 136/136；真机：真 CLI 子进程 + 真模型，单回合 101 条 update，文件落盘 "hello from acp"
- 2026-10-16 · P9（完）· 压缩策略接缝（`compactMessagesAsync` + `makeSummarizer`，失败退回丢弃）+ 预算熔断（`--max-cost`）+ `--compact=summarize` · 新增 6 个测试
- 2026-10-16 · P10（部分）· **评测套件** `scripts/evals/`：8 个任务、确定性判分、mock 模式（CI 无网络）、逐任务 token/成本/缓存/耗时、Markdown+JSON 报告；系统提示词取自 pi（仅改名字，保证可比） · mock 16/16；真模型 exact-file + read-and-write 均 pass（$0.0009, cache 3712）

- 2026-10-16 · P9 验收 · 真机长会话（31 次模型调用，带消融对照）：窗口峰值 4455/5000、0 次 API 报错；第 1 轮埋的不可猜约束在 `drop-middle` 与 `summarize` 下存活，在 `tail` 下丢失（证明是机制而非运气）；发现两条实测代价——反复压缩使缓存命中衰减到 ~66%，`summarize` 峰值更高
- 2026-10-16 · 评测方法 · 修掉一个会让测试"假通过"的设计缺陷：刺激必须躲不掉（模型曾用 offset/limit=1 绕开 8KB bulk，导致压缩根本没触发）。教训写进 scripts/evals/README.md

- 2026-10-16 · P10（完）· **LLM 裁判 + 任务集扩到 18 个**（8 原确定性 + 4 新确定性 + 6 rubric；`both` 任务同时喂确定性判分与校准）；mock 全绿（36/36，exit 0）；真机校准第一次就抓到确定性判分漏掉的真 bug（`value.trim()` 漏 TypeError）——而我两次"加固"都失败，第二次因为按引擎相关的错误措辞匹配（V8 vs Bun/JSC），最终改为断言语义并双向验证

- 2026-10-16 · 附件/多模态 · 图片走 OpenAI 兼容的 content parts（`userContent`），`estimateTokens` 计入图片；GUI 输入框支持粘贴/拖拽；server 的 create/resume 接受 `images` · 153 测试
- 2026-10-16 · GUI 审批闭环 · `createApprovalBroker` + `POST /api/sessions/:id/permissions/:requestId`，循环发 `permission.request` 后阻塞等待，GUI 出现「允许/拒绝」卡片（`MICRO_APPROVAL`）· 3 个新集成测试（允许→文件写入、拒绝→工具不执行、重复应答 404）
- 2026-10-16 · 会话树 · 侧栏 list/tree 切换，`sessionForest`/`ancestry`/`descendantCount`（防环）· 4 个纯函数测试
- 2026-10-16 · **真实长跑抓到并修掉一个严重 bug**：压缩只能丢「整个回合」，而一次编码运行常常只有 1 个 user 消息 → 单轮长任务**上下文预算完全不被执行**（实测峰值 52700 / 预算 24000，0 次压缩）。新增**步骤级裁剪**（丢 assistant+其工具结果，绝不拆散、保留任务陈述与最新一步）后同一条运行峰值 23685 / 24000、7 次压缩。多 agent 长跑另测：3 个 agent、2 个 worktree、各自独立上下文、70233 tokens、$0.0102

- 2026-10-16 · P10（评测加深）· 标注金标集 + 裁判校准：`golden.ts`（10 例，逐例 `rationale` 作证据）、`calibrate.ts`（`--mock` 走完整 prompt→strict-parse→比对→exit-code；真实模式 `--judge-model`，`--min-accuracy` 门禁，miss 时并列 judge reasons 与 label）；任务集 18→26（+4 确定性 +4 rubric）；补齐 4 个新确定性任务的 mock 脚本（此前 `run.ts --mock` 红：8 fails）· `bun test` 153/153、typecheck 干净；`run.ts --mock` 44 pass / 0 fail / 8 skipped exit 0；`calibrate.ts --mock` 10/10 exit 0
- 2026-10-16 · P10（发布）· 修单文件二进制：`--help`/`--version` 在 API key 检查**之前**处理（此前 `micro-harness --version` 直接 `missing API key` 退出 1，属发布阻塞）；抽出 `VERSION` 常量并复用给 ACP `agentInfo`；`dist/` 进 `.gitignore` · 重编 `dist/micro-harness`，`--version`=0.1.0 / `--help` 正常 / 缺 key 仍 exit 1；`bun test` 153/153
- 2026-10-16 · 文档 · ROADMAP 与实际对齐：P8/P9 总览从 ☐ 改 ✅、P1 标为「已回退」、P10 标 ◐；删掉 P8 下与已勾选条目重复的 MCP/ACP 未勾项，拆分「真实 MCP server 验收（已完成）」与「Zed 对话（未验证）」；修复损坏的 `## P9 · 上下文与经济性` 标题；勾上 P2 真机读写与 P6 inspector/diff；发布项注明「暂不发布」
- 2026-10-16 · P10 验收 · **一条命令装好 + 跑通评测**：新增 `scripts/install.sh`（`bun run build:bin` → `~/.local/bin/micro-harness`，含 PATH 提示与版本回显）；README 加安装段、陈旧 roadmap 勾选（P8/P9/P10）对齐；ROADMAP P10 验收项打勾 · `./scripts/install.sh` 装好后 `micro-harness --version`=0.1.0；`bun run eval:mock` 44 pass / 0 fail / 8 skipped；`bun test` 153/153
- 2026-10-16 · 文档 · README（英/中）同步现状：测试徽章与计数 120→153（19→21 文件）；路线图 P8/P9/P10 勾选对齐；套件描述去掉已回退内核的措辞、补 MCP/ACP/合并队列；贡献入口 P8–P10→仅 P10；中文 README 补「安装二进制」段；Bun 徽章 1.4+→1.1+（与 engines 一致）
- 2026-10-16 · 文档审计修正 · 按用户审计逐条对齐：README 种子「六个文件」→「六个源码文件」（seed-v1 实测 17 文件/6 源码）；ARCHITECTURE.md 明确标注为存档、§1/§3/§4/§5 打作废/未采用标记并把 §2 目录树换成实际结构；ROADMAP 原则「一切皆插件」→「要接缝，不要容器」；P10 口径三处统一（README 拆出独立的 [ ] 文档站条目）；P2 流式改「原计划 P2，P5 交付」；PROGRESS 日期恢复 Newest last 单调。
- 2026-10-16 · 一键启动 · server 新增**可选 GUI 静态托管**（`guiDir` / `MICRO_SERVE_GUI` / `MICRO_GUI_DIR`，`/` 与未知路径回落 index.html，`/api`·`/health` 不受影响）；`scripts/dev.sh` 加 `--single`（单进程单端口）与自动开浏览器（`--no-open` 关闭），两进程 Vite 路径不变；根脚本 `bun run ui`（单进程）/`bun run dev`；`install.sh` 额外安装全局 `microh` · 验证：单端口 `/`=HTML、`/assets/*.js`=JS、`/api/sessions`·`/health`=JSON、深链 `/deep/route` 回落 HTML；从 `/tmp` 用 `microh` 起一次亦正常；`bun test` 153/153、typecheck 干净
- 2026-10-16 · 一键启动修复 · 全局启动器改名 `micro-harness-ui` → **`microh`**（`install.sh` 装 `microh` 并移除旧名）；`dev.sh` 增加**端口占用预检** + zombie 感知的启动后检查——此前旧实例占着 8787 时，新 server 崩溃而浏览器静默连到旧实例（无 GUI，`/` 返回 JSON）· 验证：占用时明确报错 exit 1；`bun test` 153/153、typecheck 干净
- 2026-10-16 · 一键启动 UX · `microh` 幂等化：端口上已有 GUI 实例时**直接打开并 exit 0**（不再报错）；`--restart` 停旧起新；端口被「无 GUI 的旧实例」占用时仍明确提示 + 给 restart 提示 · 验证：首启=HTML、二次调用 exit 0、--restart 后仍=HTML
- 2026-10-16 · 一键启动（前台/随终端）· `microh`/`dev.sh` 改为「在任意目录前台启动、随终端生死」：工作目录=启动目录（`MICRO_CWD`，`main.ts` 新增），端口自动挑空闲（多实例并存），`trap ... HUP` 处理关终端；server 侧新增 `MICRO_EXIT_WITH_PARENT` 父进程死亡看门狗，`shutdown` 改为硬退出（`server.stop(true)` 会在活跃 SSE 上同步阻塞，之前的兜底定时器根本没机会跑）· 验证：任意目录起两个实例（8787/8788，各自 cwd）；Ctrl-C / TERM / SIGHUP 三种退出端口都释放；`bun test` 153/153、typecheck 干净
