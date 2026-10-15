# ROADMAP

> **micro-harness**：一个完整的、插件化的开源 coding-agent harness 平台——自己的 agent loop、多 agent 编排、Server + CLI + GUI，支持 MCP / ACP。
>
> 本文是长期规划。设计细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 执行纪律见本文末尾"自主执行协议"。

---

## 北极星

**一个能长期自己跑、能指挥一群 agent 干活、能接入任意模型与工具、能看得见每一步的开源 harness。**

三条不可妥协：
1. **loop 是自己的**（不是编排别人的 harness）。
2. **多 agent 是一等公民**（不是事后补的外挂）。
3. **一切可观测**（事件 → trace → replay）。

---

## 原则

- 内核小而稳，能力全外挂（"一切皆插件"）。
- 事件是唯一契约；前端只消费事件。
- 共享"能力"，隔离"状态"。
- 每个里程碑都要有**可自动验证的验收标准**（测试/命令），否则不算完成。
- 小步提交：一个可工作的增量 = 一次 commit + push。

---

## 阶段总览

| 阶段 | 名称 | 关键交付 | 状态 |
|---|---|---|---|
| **P0** | 基座 | monorepo + Bun 工具链 + CI | ✅ |
| **P1** | 内核 | Context/DI/生命周期/作用域/事件 | ✅ |
| **P2** | core | 事件化 loop + Provider + 工具审批 + 会话 JSONL | ✅ |
| **P3** | **多 agent** ⭐ | agents 服务 + `task` 工具（single/parallel/chain/race） | ✅ |
| **P4** | Server | `Bun.serve` HTTP+SSE + 会话 API + SQLite/FTS 索引 | ✅ |
| **P5** | CLI | TUI：流式、审批、斜杠命令、多 agent 树视图 | ✅ |
| **P6** | GUI | 迁移 PiStudio React：trace/inspector/replay/diff | ✅ |
| **P7** | 隔离与合并 | worktree 隔离 + 差异 + 合并队列 | ✅ |
| **P8** | 互操作 | MCP client + ACP server | ☐ |
| **P9** | 上下文与经济性 | 压缩策略 + 缓存前缀 + 成本计量 | ☐ |
| **P10** | 评测与发布 | evals + 单文件二进制 + 包发布 | ☐ |

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
- [x] **流式** text/thinking delta（P2 延后，P5 完成）；[x] **并行工具调用**
- [x] 会话 **JSONL** 追加写 + **replay**
- [x] 取消（AbortSignal）+ 步数上限
- [x] core 挂到内核插件（提供 `tools` / `providers` 服务）

**验收**
- [x] `bun test` 覆盖：事件序列、工具错误回灌、并行工具、审批拒绝、会话 replay、agent 标记
- [ ] 真机跑通：写文件 → 读回 → 正确作答（CLI 已可）
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
- [ ] diff 审阅 / inspector（context、system prompt）——留待后续

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
- [ ] ACP server（让编辑器驱动）
- [x] 关键结论：MCP 用"启动时读配置"就够了，**不需要容器**——见 docs/design-comparison.zh-CN.md
- [ ] **MCP client**：接入 stdio / streamable-http，工具自动注册
- [ ] **ACP server**：Zed / DSH 等可驱动我们
- [ ] 验收：接入一个真实 MCP server；Zed 里能对话
 · 上下文与经济性

- [x] **缓存前缀保全**：工具输出在*写入时*截断（前缀不再被事后重写）+ 压缩保留头部而非砍头——实测真 DeepSeek 命中 69–78%
- [x] **成本/缓存命中计量**：DeepSeek/OpenAI/Anthropic 三种方言归一化成 `usage.cacheRead`，按缓存折扣计价，GUI 显示命中率
- [ ] 压缩策略插件：`summarize` / `structured-state`（当前是 `keep-head+tail`，接缝已留：`compactMessages(messages, { keepHead })`）
- [ ] 预算熔断（交互式运行；`run --auto` 已有 `--max-cost`）
- [ ] 验收：长会话不爆窗口 + 命中率报告（单测已覆盖压缩与前缀稳定性，缺真实长会话实测）

## P10 · 评测与发布

- [ ] `evals/`：任务集 + runner + 报告
- [ ] `bun build --compile` 出单文件二进制（macOS/Linux）
- [ ] npm/bun 发布 + 文档站
- [ ] 验收：`micro-harness` 一条命令装好、跑通评测

---

## 自主执行协议

在无人值守的长跑中，每个增量必须满足：

1. **先写测试，或至少写可运行的验收命令**；不通过不算完成。
2. **小步提交**：`feat|fix|test|docs(scope): ...`，一次 commit 只做一件事。
3. **提交前必过**：`bun run typecheck && bun test`。
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
