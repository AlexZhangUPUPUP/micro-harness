# ROADMAP

> **micro-harness**：一个完整的、插件化的开源 coding-agent harness 平台——自己的 agent loop、多 agent 编排、Server + CLI + GUI，支持 MCP / ACP。
>
> 本文是长期规划。设计细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 执行纪律见本文末尾"自主执行协议"。

## 当前版本安排（2026-10-22）

后续执行以 [版本功能计划](docs/version-plan.zh-CN.md) 为准，覆盖每版功能清单、依赖、验收门槛和长期扩展。当前包版本为 v0.2.1；下面 P0～P10 是历史基础建设记录，勾选表示当时已交付，不代表长任务可靠性、共享预算或完整恢复已经成熟。

| 计划版本 | 主要交付 |
| --- | --- |
| v0.2.2 | 整理当前上下文、来源证据与可靠性增量 |
| v0.3 | 结构化任务状态、修订与验收记录 |
| v0.4 | 整棵 Agent 树的共享预算、取消与运行生命周期 |
| v0.5 | 工具调度、并发冲突、幂等与权限一致性 |
| v0.6 | 进程恢复、持久化兼容、变更归属与受保护撤销 |
| v0.7 | 仓库理解、代码工具与验证修复闭环 |
| v0.8 | 有契约、可验收的多 Agent 协作 |
| v0.9 | Provider 能力、MCP/ACP 与扩展契约 |
| v0.10 | 大会话性能、断线恢复与 CLI/GUI 使用闭环 |
| v0.11 | 真实任务回归、跨平台支持矩阵与发布候选 |
| v1.0 | 满足明确发布门槛的本地开发稳定版 |
| v1.1+ | 长期记忆、后台工作流、扩展平台；团队云服务独立评估 |

第一波已落地最小纵向切片：任务生命周期、共享 RunBudget、父子取消传播和 GUI 显式完成确认，详见 [specs/008-first-wave](specs/008-first-wave)。

执行治理第一步已落地：工具状态事件、审批取消清理和 GUI 状态展示，详见 [specs/009-execution-governance](specs/009-execution-governance)。

第二至第四波已拆为独立 Spec：执行策略 [010](specs/010-execution-policy)、恢复工作区 [011](specs/011-recovery-workspace)、代码闭环 [012](specs/012-code-loop)、Agent 契约 [013](specs/013-agent-contract)、Provider 互操作 [014](specs/014-provider-protocols)、大会话体验 [015](specs/015-large-session-ux)。

当前增量进度：第二波已覆盖工具状态、幂等/冲突、取消清理、未知副作用恢复和 worktree 扫描；第三波已覆盖 Agent 终态/契约、父任务 checks 与产物验收、有界搜索、结构化验证命令和会话验证状态；第四波已覆盖 Provider 能力声明、MCP/ACP 取消、MCP stdio 进程组终止与显式重连、ArtifactStore、SSE 游标、慢消费者断开、事件分页、GUI 任务增量投影、产物面板和 Artifact Range 下载。剩余验收仍包括完整协议夹具与发布矩阵。

发布矩阵已整理到 [docs/support-matrix.zh-CN.md](docs/support-matrix.zh-CN.md)，CI/Release 固定 Bun 1.4.3 并使用冻结 lockfile；真实模型和外部服务仍需按矩阵单独验证。

CI 主测试已扩展为 Ubuntu/macOS 矩阵，Release 继续产出 darwin-arm64/linux-x64 CLI。

启动恢复扫描已覆盖遗留 active 会话，恢复不会伪造仍在运行的状态。

worktree 扫描已通过 Server/GUI API 暴露，审查端可以读取 clean、dirty、missing、unknown 状态。

Provider 能力夹具已覆盖请求前拒绝路径，避免未验证的能力被静默降级。

`bun run verify` 现已覆盖第二至第四波关键链路，当前本地 31/31 checks 通过。

以上均为计划版本，尚未发布。下一项是整理 v0.2.2，再实现 v0.3；不因列入路线图而自动执行所有开发或发布操作。

---

## 北极星

**一个能长期自己跑、能指挥一群 agent 干活、能接入任意模型与工具、能看得见每一步的开源 harness。**

三条不可妥协：
1. **loop 是自己的**（不是编排别人的 harness）。
2. **多 agent 是一等公民**（不是事后补的外挂）。
3. **一切可观测**（事件 → trace → replay）。

---

## 原则

- 能力走**编译期接缝**，不走运行时容器（"要接缝，不要容器"）。
- 事件是唯一契约；前端只消费事件。
- 共享"能力"，隔离"状态"。
- 每个里程碑都要有**可自动验证的验收标准**（测试/命令），否则不算完成。
- 小步提交：一个可工作的增量 = 一次 commit + push。

---

## 阶段总览

| 阶段 | 名称 | 关键交付 | 状态 |
|---|---|---|---|
| **P0** | 基座 | monorepo + Bun 工具链 + CI | ✅ |
| **P1** | 内核 | Context/DI/生命周期/作用域/事件 | ↩️ 已回退 |
| **P2** | core | 事件化 loop + Provider + 工具审批 + 会话 JSONL | ✅ |
| **P3** | **多 agent** ⭐ | agents 服务 + `task` 工具（single/parallel/chain/race） | ✅ |
| **P4** | Server | `Bun.serve` HTTP+SSE + 会话 API + SQLite/FTS 索引 | ✅ |
| **P5** | CLI | TUI：流式、审批、斜杠命令、多 agent 树视图 | ✅ |
| **P6** | GUI | 迁移 PiStudio React：trace/inspector/replay/diff | ✅ |
| **P7** | 隔离与合并 | worktree 隔离 + 差异 + 合并队列 | ✅ |
| **P8** | 互操作 | MCP client + ACP server | ✅ |
| **P9** | 上下文与经济性 | 压缩策略 + 缓存前缀 + 成本计量 | ✅ |
| **P10** | 评测与发布 | evals + 单文件二进制 + 包发布 | ✅ evals + 二进制 + 文档站（GitHub Pages）；npm 发布已决定跳过 |

**第一晚目标：P0 → P1 → P2 → P3（最小可用多 agent）。**

---

## P0 · 基座

**目标**：把现有最小实现重组成 monorepo，工具链换成 Bun，CI 绿。

**交付**
- [x] monorepo：`packages/core`（迁移）+ `packages/kernel`（P1）；providers/server/cli/gui 留到各自阶段
- [x] 现有 `src/*` 迁进 `packages/core/src/*`，`test/*` 跟着迁
- [x] Bun 工具链：`bun test`、`bun run typecheck`、workspace 脚本
- [x] `tsconfig.base.json` + paths（`@micro-harness/*`）
- [x] CI：`bun install && bun test && bun run typecheck`
- [x] `main` 保持"最小 harness"可运行；平台开发在 `platform` 分支

**验收**
```bash
bun install && bun test          # 7/7 通过
bun run typecheck                # 0 错误
bun packages/core/src/cli.ts "hi" # 能跑
```

---

## P1 · 内核 —— ⚠️ 已回退（2026-10-16）

**结果：做出来并删除了。** 实现是 396 行代码 + 10 个测试（`provide`/`get`/`inject`、生命周期、
作用域、事件总线、config schema），但测量显示它**不承重**：`@micro-harness/kernel` 只被
引用 1 次且是 `import type`，插件对象与注册表有 **0** 个运行时消费者，而仓库里 25 个装配点
每一个的依赖都是"可选 + 有默认值"。

**为什么删**：容器只买「运行时组装」这一件事，而我们的能力都是"启动时读配置"。留下投机
抽象层就是第二种"README 撒谎"。详见 [docs/design-comparison.zh-CN.md](docs/design-comparison.zh-CN.md)。

**什么条件下恢复**：当出现**配置驱动的能力消费者**——能力必须在进程活着的时候来去、且不能
重启（例如 MCP server 热插拔，掉线要撤回它的工具）。届时从 commit `5df4ba9` 恢复，并按那个
真实需求重写，而不是按想象的需求。

### 原计划（已作废，仅存档）

**目标**：实现 ARCHITECTURE 第 3 节的 Context/DI/生命周期/作用域/事件。

**交付**
- [x] `createContext()`：`provide/get/inject/on/emit/effect/fork/isolate`
- [x] 插件契约：`{ name, inject?, Config?, apply(ctx, config) }`
- [x] 生命周期：`waiting→active`，`failed`（隔离）
- [x] **依赖就绪才激活**；服务出现/消失触发**重绑定**
- [x] **销毁反序 + 异步 dispose await**
- [x] 作用域：`fork()` / `isolate()`
- [x] 事件总线
- [x] Config schema 校验（结构式 `Schema.parse`）+ 错误标记
- [x] 错误隔离：单插件 `failed` 不崩整棵树

**验收（10 个测试全绿）**
- [x] 依赖 B 的 A 在 B 注册后才 `active`
- [x] B 注销 → A 回滚为 `waiting`，其 effect 被销毁
- [x] `provide` 同名 → 报错
- [x] 销毁顺序 = 激活反序；异步 dispose 被 await
- [x] 一个插件抛错 → 其他插件正常，诊断标记 `failed`
- [x] `fork()` 后 `isolate` 不上泄、不外泄到兄弟作用域
- [x] `inject` 随服务出现/消失而启动/回滚

---

## P2 · core（事件化 loop）

**目标**：把最小 loop 升级为"事件驱动 + Provider 抽象 + 工具审批"。

**交付**
- [x] **AgentEvent**（含 `agentId` / `parentId`）—— 唯一契约（`events.ts` + `EventHub`/`AgentLog`）
- [x] loop 只发事件，不直接输出
- [x] `Provider` 接口 + `openai-compatible` 适配器（DeepSeek 可用）
- [x] 工具注册表 + JSON Schema + 路径沙箱 + **审批级别**（suggest/auto-edit/full-auto）
- [x] **流式** text/thinking delta（原计划 P2，P5 交付）；[x] **并行工具调用**
- [x] 会话 **JSONL** 追加写 + **replay**
- [x] 取消（AbortSignal）+ 步数上限
- [x] core 挂到内核插件（提供 `tools` / `providers` 服务）

**验收**
- [x] `bun test` 覆盖：事件序列、工具错误回灌、并行工具、审批拒绝、会话 replay、agent 标记
- [x] 真机跑通：写文件 → 读回 → 正确作答（真 DeepSeek；evals 的 `read-and-write` 任务亦为真机通过）
- [x] 生成的 JSONL 可被 replay 出同一事件序列

---

## P3 · 多 agent ⭐（必做，提前）

**目标**：`agents` 服务 + `task` 工具，进程内 fork 隔离，最小可用。

**交付**
- [x] `agents` 服务：角色注册表 `{name, model?, systemPrompt?, tools?, maxSteps?, isolation?}`
- [x] `task` 工具：**single / parallel / chain / race**
- [x] 子 agent 用 `ctx.fork()`：**全新 messages**、继承 providers/store
- [x] **上下文防火墙**：父只收子 agent 的**摘要/结果**（不回注 transcript）
- [x] 限制：`maxDepth`、并发信号量、每子 agent **独立预算**（tokens/cost）、超时
- [x] 事件带 `agentId`/`parentId` → 可重建 agent 树
- [x] CLI 打印 agent 树 + 每个 agent 的成本
- [x] 角色定义以**配置文件/插件**加载（如 `agents/*.md`）

**验收**
- [x] orchestrator 一次委派 2 个子 agent（parallel），各自返回结果
- [x] 子 agent 上下文与父**不串**（断言 messages 不泄漏）
- [x] 超过 maxDepth 被拒；并发被信号量限制
- [x] 每个子 agent 的成本单独可见
- [x] chain 模式 `{previous}` 正确传递
- [x] race 模式返回全部结果并标出"胜者"（按成本/时长）

**不做（留给 P7）**：并行改文件的 worktree 隔离与合并。

---

## P4 · Server

- [x] `Bun.serve`：HTTP + **SSE** 事件流
- [x] 会话 API：list / get / create / resume / fork / delete
- [x] SQLite 索引（`bun:sqlite`）：会话元数据 + **FTS5** 全文 + 用量/运行历史（可删可重建）
- [x] 鉴权 token（非 loopback 必填）
- [x] 验收：`curl` 能起会话、流式收事件、全文搜索命中

## P5 · CLI

- [x] TUI（ink 或自绘）：流式渲染、工具卡片、审批交互
- [x] 斜杠命令、prompt 模板、技能
- [x] **多 agent 树视图** + 每个 agent 的成本/状态
- [x] 权限模式（suggest / auto-edit / full-auto）
- [x] **无人值守驱动**：`micro-harness run --auto`（任务队列 + 循环 + 预算/超时护栏），对标 `scripts/auto-run.sh`
- [x] 验收：终端里完成一次多 agent 任务

## P6 · GUI

- [x] `packages/gui`：React 19 + Vite + Tailwind，复用 PiStudio 的设计 token，对接新 server
- [x] 事件驱动展示层（`src/lib/derive.ts`：事件流 → 聊天 / agent 树，纯函数、可单测）
- [x] **trace 面板 + replay 滑杆**（按 seq 切片事件流，会话随之重建）
- [x] **多 agent 面板**：agent 树 + 每个 agent 的 token/成本/工具数
- [x] 验收：GUI 能对话、看 trace、看多 agent 树（`docs/gui.png`，已 OCR 校验）
- [x] diff 审阅 / inspector（context、system prompt）—— inspector 面板展示发给模型的原始 payload；diff 支持 hunk 级 accept/reject

## P7 · 隔离与合并

- [x] **git worktree 隔离**：`AgentRunner.isolation='worktree'`，每个子 agent 一个工作区；发出 `agent.worktree` 事件
- [x] 差异预览：`worktreeDiff`（改了什么 + 统一 diff）
- [x] **合并队列**：`integratePreview` 依次三方合并每个 agent（自动解干净的 + 冲突汇总）+ `integrateApply`
- [x] 移植自 PiStudio 已验证的 `worktree.js` / `merge.js`（逻辑未改，`isolation.ts` 为类型化门面）
- [x] CLI `--isolate`；server `MICRO_ISOLATE=1` + `/agents`、`/agents/:id/diff|promote|cleanup`、`GET|POST /integrate`
- [x] 验收：两个 agent 并行写不同文件 → 一键合并；写同一文件 → 冲突被标出（测试覆盖）
- [x] GUI：agent 上的 `wt` 徽章 + **changes 面板**（每 agent diff / promote + integrate all）

## P8 · 互操作

- [x] **MCP client**：stdio + streamable HTTP 两种传输（不引官方 SDK）；`mcp.json` 启动时读取；工具按 `<server>__<tool>` 命名空间合并进注册表；`GET /api/mcp` 报告状态。已对官方参考 server 端到端验证（13 工具 → 模型调用 → 42）
- [x] **ACP server**（让编辑器驱动我们）：协议 v1，JSON-RPC/NDJSON；`initialize`/`session/new`/`session/prompt`/`session/cancel` 入，`session/update`+`session/request_permission`+`fs/*` 出；`micro-harness acp` 启动。真机验证：真 CLI 子进程 + 真模型，单回合 101 条 update，文件确实落盘
- [x] 关键结论：MCP 用"启动时读配置"就够了，**不需要容器**——见 docs/design-comparison.zh-CN.md
- [x] 验收：接入一个真实 MCP server（官方参考 server 端到端：13 工具 → 模型调用 → 42）
- [x] 验收：在 Zed 里驱动我们对话 —— **已通过**（Zed 1.24.2；`scripts/acp.sh` + `agent_servers` 配置；Agent Panel 中可正常调用 micro-harness）

## P9 · 上下文与经济性

- [x] **缓存前缀保全**：工具输出在*写入时*截断（前缀不再被事后重写）+ 压缩保留头部而非砍头——实测真 DeepSeek 命中 69–78%
- [x] **成本/缓存命中计量**：DeepSeek/OpenAI/Anthropic 三种方言归一化成 `usage.cacheRead`，按缓存折扣计价，GUI 显示命中率
- [x] **压缩策略**：确定性的 `drop-middle`（默认）+ `summarize`（`--compact=summarize`，一次模型调用把被丢的轮次折成一段 recap，失败自动退回）。`structured-state` 仍未做
- [x] **预算熔断**：`--max-cost` / `MICRO_MAX_COST`，累计成本超限即停并发 `error(fatal)` + `turn.end{stopReason:"budget"}`
- [x] **验收（真机，带消融）**：31 次模型调用的长会话，窗口峰值 4455/5000 且 0 次 API 报错；埋在第 1 轮的不可猜约束在默认策略下存活，**同一条会话换成 `tail`（不保留开头）则丢失**——证明是机制在起作用；`summarize` 同样存活。代价：反复压缩让缓存命中降到 ~66%（短会话是 69–78%）

## P10 · 评测与发布

- [x] `evals/`：任务集 + runner + 报告 —— 26 任务（确定性 + LLM 裁判 + rubric），`--mock` 无网确定性、CI-safe；新增**标注金标集 + 裁判校准 CLI**（`golden.ts` 10 例、`calibrate.ts`，`--min-accuracy` 门禁）
- [x] `bun build --compile` 出单文件二进制（macOS/Linux）—— `dist/micro-harness`，`--help`/`--version` 无需 API key 即可用
- [x] 文档站：`scripts/build-docs.ts` 把 Markdown 渲染成带侧栏的静态站（`bun run docs:build` → `site/`），`.github/workflows/pages.yml` 发布到 GitHub Pages
- [ ] npm/bun 发布 —— 暂不发布（已决定）
- [x] 验收：`./scripts/install.sh` 一条命令装好（→ `~/.local/bin/micro-harness`）+ `bun run eval:mock` 跑通（44 pass / 0 fail / 8 skipped）

---

## 自主执行协议

本节原有条目来自基础建设阶段；后续以用户当前授权、适用 AGENTS.md 和版本计划中的定向验证规则为准。文档规划不自动授权提交、推送或运行全量测试。

在无人值守的长跑中，每个增量必须满足：

1. **先写测试，或至少写可运行的验收命令**；不通过不算完成。
2. **小步提交**：`feat|fix|test|docs(scope): ...`，一次 commit 只做一件事。
3. **变更验证**：执行相关测试，适用时运行类型检查/构建；文档、注释和格式调整只做 diff/lint 检查。完整回归由明确请求或合并/发布 CI 门槛触发。
4. **只前进不破坏**：`main` 保持可用；平台工作在 `platform` 分支。
5. **阻塞就记档**：遇到外部阻塞（缺密钥、缺网络、平台限制），写进 `NOTES.md` 并跳到下一个任务，不空转。
6. **进度可查**：本文件勾选框 + `PROGRESS.md` 追加日志（时间、做了什么、验证结果）。
7. **不碰密钥**：不从 `~/.pi/agent/auth.json` 复制密钥进代码/仓库；测试用环境变量。
8. **不做危险操作**：不 `push --force`、不删远端分支、不改用户全局配置。

---

## 风险

| 风险 | 缓解 |
|---|---|
| 内核生命周期边界情况多 | P1 用测试把边界钉死 |
| 多 agent 上下文/成本爆炸 | 防火墙 + 深度/并发/预算限制 |
| 并行改文件冲突 | 只读优先，改文件走 P7 worktree |
| 范围蔓延 | 严格按阶段验收，不通过不进下一阶段 |
| 长跑中断 | 每步 commit + push；PROGRESS.md 可续跑 |
