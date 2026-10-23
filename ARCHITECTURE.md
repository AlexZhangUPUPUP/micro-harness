# ARCHITECTURE

> 目标形态：一个**完整的开源 coding-agent harness 平台**——自己的 agent loop + Server + CLI + GUI，支持 MCP 客户端与 ACP，DeepSeek 等 OpenAI 兼容模型优先。
>
> ⚠️ **本文是开工前的设计基线，属于存档。现状以 [README.md](README.md) 与 [ROADMAP.md](ROADMAP.md) 为准。**
>
> **修订（2026-10-16）**：§1「core 跑在内核上」**已被回退**——自研插件内核做出来后被测量为不承重（0 个运行时消费者），已删除，改为**编译期能力接缝**；§2 的目录树是**当时的目标态，不是今天的实际结构**；§3「内核规格」整节随之作废。原因、数字与恢复条件见 [docs/design-comparison.zh-CN.md](docs/design-comparison.zh-CN.md)。其余各节仍大体有效，但细节以现状文档为准。

---

## 0. 目标与非目标

### 目标
- **自己拥有 agent loop**（不是只编排别人的 harness）。
- ~~**一切皆插件**：provider / tool / context 策略 / 审批策略 / 命令 / UI 槽位 / 存储，全部是插件。~~ **已废弃**：能力改为**编译期接缝**（`Provider`/`Tool`/`FileSystem`/`AgentRole`/`AgentEvent`），不是运行时插件容器（见文首修订）。
- **一个内核，多个前端**：headless server + CLI + GUI（Web + 桌面）。
- **互操作**：MCP（消费外部工具/资源）、ACP（被编辑器/其他客户端驱动）。
- **性能与分发**：TypeScript + Bun，可编译成单文件二进制。
- **可观测**：事件流 + trace + replay 是一等公民。

### 非目标（v1 之前）
- 多租户云服务、团队协作、计费。
- IDE 插件（VS Code / JetBrains）。
- Windows 的 OS 级沙箱（先做路径沙箱 + 审批）。
- 自研模型推理。

---

## 1. 分层（⚠️ 已回退：内核未采用，见文首修订）

```
┌──────────────────────────────────────────────────────────────┐
│ clients:  cli/          gui/ (React + Electron)   acp clients │
├──────────────────────────────────────────────────────────────┤
│ server/   HTTP + SSE + ACP server + MCP gateway               │
├──────────────────────────────────────────────────────────────┤
│ composition/   分层 profile：base → web → user（YAML/TS patch）│
├──────────────────────────────────────────────────────────────┤
│ plugins/   providers · tools · context · policy · commands ·  │
│            storage · agents · ui-slots · hooks                │
├──────────────────────────────────────────────────────────────┤
│ kernel/    Context(DI) · 生命周期 · 作用域 · 事件总线 · schema   │
└──────────────────────────────────────────────────────────────┘
```

**分层铁律**
1. `kernel` 不认识 HTTP、不认识 React、不认识 SQLite。它只知道 **服务**、**插件**、**事件**、**作用域**。
2. `core`（agent loop）本身也是**跑在内核上的插件集**，不是内核的一部分。
3. 前端只消费**事件流**，不直接调用 loop 内部。

---

## 2. 目录树

> ⚠️ 本节原为「目标 monorepo」（`kernel/ providers/ storage/ cli/ evals/ profiles/` 多包拆分），**未采用**：内核回退后其余并入 `core`/`server`/`gui`。以下是 `main` 分支的**实际**结构。

```
harness/
  package.json                  # workspaces root（不声明运行时依赖）
  ARCHITECTURE.md  ROADMAP.md  PROGRESS.md
  packages/
    core/                       # agent loop + tools + context + provider + agents + MCP/ACP + CLI
      src/  test/
    server/                     # Bun.serve + SSE + 会话存储（JSONL + SQLite/FTS5）
      src/  test/
    gui/                        # React + Vite + Tailwind
      src/  test/
  scripts/                      # dev.sh、verify-features.ts、evals/、install.sh
```

---

## 3. 内核规格（⚠️ 已作废：内核未采用，见文首修订）

### 3.1 Context（DI + 作用域）

```ts
export interface Services {} // 通过 module augmentation 扩展

export interface Context {
  // 服务
  provide<K extends keyof Services>(name: K, value: Services[K]): void
  get<K extends keyof Services>(name: K): Services[K]

  // 依赖注入：依赖齐了才执行；依赖变化会重新绑定
  inject<K extends keyof Services>(deps: K[], fn: (ctx: Context) => void | Disposable): Disposable

  // 生命周期：随当前插件/作用域自动销毁
  effect(fn: () => void | Disposable): void

  // 事件
  on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): Disposable
  emit<E extends keyof Events>(event: E, payload: Events[E]): void

  // 作用域
  fork(overrides?: Partial<Services>): Context
  isolate<K extends keyof Services>(...names: K[]): Context

  // 配置
  readonly config: unknown
}
```

### 3.2 插件契约

```ts
export interface Plugin<C = unknown> {
  name: string
  inject?: (keyof Services)[]
  Config?: Schema<C>          // zod / valibot
  apply(ctx: Context, config: C): void
}

// 一个插件文件：
export const name = 'provider-openai'
export const inject = ['providers'] as const
export const Config = z.object({ baseUrl: z.string().url(), apiKey: z.string() })
export function apply(ctx, config) {
  ctx.effect(() => ctx.providers.register('openai', makeOpenAI(config)))
}
```

### 3.3 生命周期状态机

```
registered ──load──▶ loading ──deps ready──▶ active
                         │                      │
                         │ deps missing         │ dispose
                         ▼                      ▼
                      waiting ──deps appear──▶ active
                         │
  任意状态 ──throw──▶ failed (隔离，不影响其他插件)
```

规则：
- **依赖就绪才激活**；缺失依赖进入 `waiting`。
- **服务出现/消失会触发重绑定**（`inject` 回调重跑 / 回滚）。
- **销毁按激活的反序**，异步 `dispose` 必须 await。
- **错误隔离**：单个插件 `failed` 不能带崩整棵树；诊断里报 `failed / overridden / restart-required`。
- **幂等**：重复 `provide` 同名服务 = 错误（或显式 override）。

### 3.4 作用域隔离规则

| 服务 | root（全局） | 每个 session | 每个 sub-agent |
|---|---|---|---|
| `providers` | ✅ 共享 | 共享 | 共享 |
| `store`（会话/索引） | ✅ 共享 | 共享 | 共享 |
| `events`（总线） | ✅ 共享 | fork（带 sessionId 过滤） | fork |
| `tools` 注册表 | ✅ 共享 | 共享 | 共享（可裁剪） |
| `messages` / 上下文 | — | ✅ 每 session 一份 | ✅ 每 agent 一份 |
| `cwd` / 沙箱根 | — | ✅ 每 session 一份 | ✅ 每 agent 一份 |
| `policy` | 默认共享 | 可覆盖 | 可覆盖 |

**规则**：共享"能力"，隔离"状态"。`fork()` 复制 context，`isolate()` 让某服务在当前作用域内被覆盖而不外泄（例如每个会话自己的 `cwd`）。

### 3.5 事件总线 + AgentEvent（唯一契约）

```ts
export type AgentEvent =
  | { type: 'session.start';  sessionId: string; model: string; cwd: string }
  | { type: 'turn.start';     turn: number }
  | { type: 'text.delta';     text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.call';      id: string; name: string; args: unknown }
  | { type: 'tool.result';    id: string; name: string; ok: boolean; output: string; ms: number }
  | { type: 'usage';          input: number; output: number; cacheRead?: number; cost?: number }
  | { type: 'context.trim';   dropped: number; tokens: number; strategy: string }
  | { type: 'permission.request'; id: string; tool: string; args: unknown }
  | { type: 'permission.result';  id: string; decision: 'allow' | 'deny' }
  | { type: 'turn.end';       stopReason: string }
  | { type: 'session.end';    reason: string }
  | { type: 'error';          message: string; fatal?: boolean }
```

**所有事件**：① 在 SQLite 事务中写入事实存储；② 更新 JSONL 兼容导出；③ 通过 SSE / ACP 广播。前端 = 事件消费者。GUI 的 trace / inspector / replay 全部基于同一事件表。

---

## 4. 组合层（composition）（⚠️ 目标态：profile 组合层未采用）

对标 DSH 的 `cordis.patch.yml`，但语义由我们定义。

```yaml
# profiles/web.yml
- layers: [base, web]
- insert:
    - id: provider-deepseek
      name: '@harness/provider-openai'
      config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }
    - id: tool-bash
      name: '@harness/tool-bash'
    - id: ui-sidebar
      name: '@harness/ui-sidebar'
- id: context-window            # 覆盖已有行的 config（整体替换，不深合并）
  config: { maxTokens: 32000, compact: true }
```

语义（必须写进文档、可测试）：
1. **profile = 有序的 layer 列表**；后面的层覆盖前面的。
2. **`insert`** 追加行；每行必须有唯一 `id`。
3. **按 `id` 覆盖**：整行替换；**`config` 是整体替换，不是深合并**（想保留要重述）。
4. **优先级**：user 层 > app 层 > base；诊断里报 `overridden`。
5. **一个 profile 就是一套启动形态**：`headless` / `web` / `sdk` / `acp`。

---

## 5. 插件点清单（extension points）（⚠️ 已被编译期接缝取代）

| 插件点 | 用途 | 进程内/外 |
|---|---|---|
| `providers` | 模型接入：openai-compatible / anthropic / gemini / ollama | 内 |
| `tools` | read/write/list/bash/search + 自定义 | 内；外部经 **MCP** |
| `context` | 窗口策略、压缩、**缓存前缀**策略 | 内 |
| `policy` | 审批级别（只读/需确认/自动）、路径沙箱 | 内 |
| `commands` | 斜杠命令、prompt 模板、技能 | 内 |
| `storage` | 会话 JSONL、SQLite 索引 | 内 |
| `agents` | sub-agent 定义、编排策略 | 内 |
| `ui-slots` | 客户端槽位：侧栏 / 消息渲染器 / 设置页 | 前端 |
| `hooks` | 生命周期钩子：pre/post model、pre/post tool | 内 |

**一条操作两处调用**（借 DSH 的做法）：业务实现成 **Host service 方法**，UI 通过 server 调它，agent 通过**同名工具**调它——不重复实现；涉及授权的操作（批准、放宽策略）**仅用户**可触发。

---

## 6. 进程内外边界

| 边界 | 用什么 | 适合 |
|---|---|---|
| **进程内插件** | 我们的 kernel（TS，全能力） | 一方/可信：provider、tool、context、UI |
| **进程外工具** | **MCP**（stdio / streamable-http） | 三方、任意语言、需沙箱 |
| **被外部驱动** | **ACP**（我们提供 server） | Zed / DSH / 任何 ACP 客户端 |

安全：进程内插件**完全信任**（需能力声明 + 审核）；不可信逻辑一律走 MCP + 沙箱。

---

## 7. 存储

- **事实来源**：**SQLite**（Bun 用 `bun:sqlite`），以事务保存会话元数据、完整事件和 FTS5 索引。
- **兼容导出**：会话 JSONL 和 `meta.json` 保留为可读备份、迁移输入和故障诊断材料，可用 `SessionStore.exportSession()` 从 SQLite 重建。
- **trace**：`traces/run-*.jsonl`，每条事件一行。

---

## 8. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript** | 生态最全（MCP/ACP/provider SDK）、与 GUI 同语言、已有大量 TS 可复用 |
| 运行时/分发 | **Bun**（`bun build --compile` 出单文件） | 启动快、单二进制、自带 `bun:sqlite`/`Bun.serve`/`bun test`/`Bun.spawn` |
| 内核 | **自研最小内核**（本文件第 3 节） | 插件面窄、完全掌控、可平滑迁移到 Cordis |
| Schema | zod（或 valibot） | 插件 `Config` 校验 |
| HTTP | `Bun.serve` | 零额外依赖 |
| GUI | React + Vite + Electron（迁移 PiStudio） | 已有 33 组件 + 26 张截图 |
| 依赖策略 | **允许依赖**（不追求零依赖），但 **kernel/core 保持极少** | 内核稳定 > 花哨 |

---

## 9. 里程碑

| 版本 | 交付 | 验收 |
|---|---|---|
| **v0.2** core 硬化 | 事件化 loop、Provider 接口、工具审批/沙箱、流式、并行工具调用、JSONL 会话 | CLI 能完成一个多步编码任务并落 trace |
| **v0.3** server | `Bun.serve` HTTP + SSE、会话 API、SQLite 索引（FTS）、基础 CLI | `curl` 能起会话、流式收事件、全文搜索 |
| **v0.4** gui | 迁移 PiStudio React，接 server | GUI 能对话 + 看 trace + 看 diff |
| **v0.5** 插件化 | kernel + composition + 第一个 provider/tool/ui 插件 | 能用 YAML profile 换一套行为 |
| **v0.6** 多 agent | sub-agent 工具、任务运行时、隔离（worktree）、合并队列 | 一次跑 N 个 agent 并合并 |
| **v1.0** 互操作 | **MCP client** + **ACP server** + `evals/` | Zed 能驱动我们；接入一个 MCP server；跑通评测 |

---

## 10. 决策记录（ADR）

- **ADR-001 自研内核，不直接用 Cordis。** 插件面窄，通用框架 60% 用不上；自研可完全掌控；接口按 Cordis 的样子设计，将来可平滑迁移。
- **ADR-002 TypeScript + Bun，不用 Rust/Go。** 主流 harness（pi / OpenCode / Claude Code）源码都是 TS；Bun 编译解决启动与分发；Codex 那种 Rust core 留作后期 sidecar。
- **ADR-003 SQLite 为事实来源 + JSONL 为兼容导出。** 事务保证一致性，导出保留可移植和可 grep 能力。
- **ADR-004 事件是唯一契约。** loop 只发事件；server/GUI/CLI/trace 全是消费者。
- **ADR-005 进程内插件 + MCP 进程外 + ACP 边缘。** 可信的进程内，不可信的走 MCP。
- **ADR-006 不与 DSH 竞争，做它的邻居。** 通过 ACP 可被 DSH/Zed 驱动；也可作为 DSH 插件存在。

---

## 11. 参考项目

| 参考 | 偷什么 |
|---|---|
| **DSH / Cordis** | 插件树 + composition（patch/override）+ 服务注入 + UI 槽位 + 插件管理器三态 |
| **OpenCode** | client/server 架构；Bun 单文件分发 |
| **Codex CLI** | 审批模式 + OS 沙箱；Rust core + JS 外壳 |
| **Claude Code** | 权限规则、hooks、subagents、checkpoints（功能面参考） |
| **OpenHands** | 事件流架构 + 运行时沙箱 |
| **Aider** | git-native（自动 commit / undo）、repo map |
| **Crush** | LSP 集成（把诊断喂回模型） |
| **Gemini CLI** | monorepo `core`/`cli` 分层 |
| **Zed (ACP)** | 编辑器和 agent 的协议边界 |
| **MCP** | 进程外工具标准 |

---

## 12. 待决问题

1. **产品名**（影响所有包名、`@scope/*`）。
2. profile 配置用 **YAML** 还是 **TS**？（YAML 可 diff，TS 可写逻辑）
3. 是否 v0.4 就迁 PiStudio 的 GUI，还是先做 CLI 验证内核？
4. 会话压缩策略：纯窗口裁剪，还是引入"摘要 + 保留缓存前缀"（影响成本）。
