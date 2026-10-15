# micro-harness

**一个基于插件的编码 agent 平台** —— 自带 agent 循环、多 agent 编排、服务端、CLI 与
Web GUI，从一份极简可读的 harness 长出来。

[English](README.md) · **简体中文**

> **极简种子在哪？** 原始的种子——`src/` 下六个文件，零依赖、无构建步骤，Node ≥ 22.18
> 直接运行——已经冻结在
> [`seed-v1`](https://github.com/AlexZhangUPUPUP/micro-harness/tree/seed-v1) 这个 tag 上。
> 想理解 agent harness 怎么工作，就从那份从头读到尾；本分支是在同一套设计上长出来的平台。
> 平台的 P0 把种子移进了 `packages/core`，所以这里没有 `src/`。

> 所谓 **agent harness**（agent 运行时），就是包在 LLM 外面、把它变成 agent 的那层：
> 跑循环、执行工具、管理上下文窗口、跟模型对话。

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

## 运行

```bash
bun install

# CLI —— 种子里那个 cli.ts 长大了，现在在 packages/core/src/cli.ts
bun start "创建 hello.txt 写入 'hi'，然后读回来打印内容"
bun start                       # 交互式 REPL（/help、提示词模板、skills）
bun start --allow-bash "找出最大的 3 个文件并总结"
bun start --isolate --tree "…"  # 每个子 agent 一个 git worktree + 打印 agent 树
bun start -- run --auto --tasks tasks.txt   # 无人值守驱动（预算 + 超时）

# 整套：服务端（SSE + SQLite/FTS）与 GUI
scripts/dev.sh                  # → http://127.0.0.1:5273
```

| 参数 | 含义 |
|---|---|
| `--dir <path>` | 工具被沙箱限制的工作目录（默认 `.`） |
| `--model <id>` / `--base-url <url>` | 覆盖环境变量里的配置 |
| `--approval <mode>` | `suggest` / `auto-edit` / `full-auto`（默认 `full-auto`） |
| `--allow-bash` | 启用 `bash` 工具（默认关闭） |
| `--isolate` | 每个子 agent 一个独立 git worktree |
| `--tree` | 运行结束后打印 agent 树 |
| `--max-steps <n>` / `--max-context <n>` | 循环步数（24）/ 上下文预算（24000） |
| `--trace` | 把每个事件追加到 JSONL 轨迹文件 |
| `--quiet` | 不打印工具活动 |

## 四个部件

它们依然是这个项目的核心——种子里的四个文件现在位于 `packages/core/src/`，其它一切都
是围着它们长出来的：

| 文件 | 它是什么 |
|---|---|
| `packages/core/src/harness.ts` | **循环** —— 模型 → 工具 → 把结果喂回去 → 重复，带步数上限、并行工具调用和审批模式 |
| `packages/core/src/tools.ts` | **工具注册与调度** —— `read_file`、`write_file`、`list_dir`、`bash`；路径沙箱；工具报错会变成消息，模型可以从中恢复 |
| `packages/core/src/context.ts` | **上下文窗口** —— token 估算 + 裁剪，始终保留 system prompt 和完整回合，绝不把 tool 结果和它的调用拆散 |
| `packages/core/src/model.ts` | **模型 I/O** —— OpenAI 兼容的 `chat/completions` 调用，带流式与 429/5xx 重试 |

## 设计要点

- **种子零依赖，平台不是。** `main` 的 `src/` 只用 Node 内置模块。本分支是 Bun 单体仓库
  —— Bun 做工具链、`bun:sqlite` 做索引、React + Vite + Tailwind 做 GUI——不过根
  `package.json` 依然没有声明任何运行时依赖。
- **错误也是数据。** 工具失败返回 `{ output, isError: true }`，作为一条普通的 `tool`
  消息追加进去——模型看得到失败原因并可以重试，这正是 agent 循环能稳住的关键。
- **沙箱。** 文件工具会把每个路径解析到 `--dir` 内部并拒绝越界；`bash` 需要显式开启。
- **裁剪不拆回合。** 一条 `tool` 消息永远和产生它的 assistant `tool_calls` 一起保留。
- **事件是唯一的契约。** 循环只产出一条带标签的事件流；会话 JSONL、服务端 SSE、CLI、
  GUI 的轨迹/回放以及检视面板都只是它的消费者。
- **能力共享，状态隔离。** provider、工具和存储是共享的；消息、cwd 和策略按会话、按
  子 agent 隔离。

## 测试

```bash
bun install
bun test          # 单元测试：kernel、core、server、gui 的派生逻辑
bun run verify    # P3/P4/P5 功能自检（脚本化 provider，不走网络）
bun run typecheck
```

## 包结构

- `packages/kernel` —— 插件内核：服务/依赖注入、生命周期、作用域、事件
- `packages/core` —— agent 循环、工具、上下文、provider、多 agent、会话、CLI
- `packages/server` —— HTTP + SSE + SQLite/FTS 索引
- `packages/gui` —— React Web 界面

## GUI

React 19 + Vite + Tailwind 前端（设计 token 与 PiStudio 共用）：会话列表、带工具卡片的
流式对话、带每个 agent token/成本的 **多 agent 树**、能用 **回放拖动条**从事件流任意
切片重建对话的 **轨迹面板**，以及服务端以 `MICRO_ISOLATE=1` 运行时的 **改动面板**
（每个 agent 的 diff / 合并回主干 + 一键整合的 **合并队列**）。

![GUI](docs/gui.png)

打开隔离后，每个子 agent 拿到自己的 git worktree，因此并行 agent 之间不会互相覆盖：

![合并队列](docs/gui-changes.png)

既然 agent 的产物就是一份 diff，改动面板支持**逐 hunk 审阅**：勾选你要的部分，只应用
这些。`packages/core/src/patch.ts` 解析 diff 并只回放被接受的 hunk，`POST
…/agents/:id/apply` 再通过既有的 integrate/apply 路径落盘，于是备份和冲突报告都是白送的。
上下文已经漂移的 hunk 会被报告出来，而不会被错误应用：

![逐 hunk 审阅](docs/gui-hunks.png)

界面是双语的——**English / 简体中文**——用 `中 / EN` 按钮原地切换（首次访问跟随浏览器语言）：

![简体中文界面](docs/gui-zh.png)

```bash
# 一条命令：同时起服务端和 GUI，并自动找一个可用的 API key
scripts/dev.sh                 # → http://127.0.0.1:5273

# 或者自己起两半：
MICRO_API_KEY=… bun packages/server/src/main.ts          # 终端 1
cd packages/gui && MICRO_SERVER=http://127.0.0.1:8787 bun run dev   # 终端 2
```

服务端会读取 `MICRO_MODEL`（用厂商真实的模型 id，例如 `deepseek-chat`）、
`MICRO_BASE_URL`、`MICRO_API_KEY`、`MICRO_DATA_DIR` 和 `MICRO_MODELS`。`dev.sh` 会打印
它最终用了哪把 key——`key sk-41cdf912… (from ~/.pi/agent/auth.json)`——并且在环境变量里
的 key 与 `auth.json` 里的不一致时给出警告；否则那就是一个让人摸不着头脑的 402
「为什么我余额是 0」。

对话区支持 **Markdown 渲染与代码高亮**（从 PiStudio 移植的零依赖渲染器），**⌘K** 打开
命令面板，同时对所有已保存会话做全文检索（`/api/search`，FTS5）：

![命令面板](docs/gui-palette.png)

右侧面板有四个视图。**agents** 画出子 agent 树及每个节点的用量（悬浮节点看详情卡）；
**轨迹** 是原始事件流，带分类 chip、文本过滤和回放拖动条；**改动** 逐 hunk 审阅某个
agent 的 diff；**检视** 回答「我们到底给模型发了什么」——每一次调用都展示实际发出的
载荷：系统提示词、工具 schema，以及每一条消息，直接来自 `model.request` 事件：

![检视面板](docs/gui-inspector.png)

![轨迹面板](docs/gui-trace.png)

GUI 渲染的一切都由 `packages/gui/src/lib/derive.ts` 里的纯函数从事件流派生（有单元测试）。

让它像个真正编码工具的那些细节：实时用量是**滚动到新值的数字，旁边是每次模型调用的
token 迷你折线图**；agent 树画出真正的连线并在悬浮时给出详情卡；改动面板渲染**带新旧
行号栏的着色 diff**；会话按 **今天 / 昨天 / 更早** 分组并支持悬浮删除；对话只在你还停在
底部时自动跟随（往上滚就冻结，并浮出「回到底部」胶囊）；拖动轨迹会让整个界面变成去饱和的
**REPLAY** 模式。

### 键盘

| 按键 | 行为 |
|---|---|
| `⌘K` / `Ctrl K` | 命令面板 —— 应用动作 + 会话全文检索 |
| `⌘/` | 键盘快捷键速查表 |
| `↑` `↓` | 在侧栏或命令面板中移动 |
| `Enter` | 发送 |
| `⇧ Enter` | 在输入框内换行 |
| `Esc` | 关闭任意弹窗 |

命令面板还能把当前会话导出为 Markdown、把原始轨迹复制成 JSON。当一次运行在你没看这个
标签页时结束，会弹一条桌面通知。

会话可以**就地重命名**（悬浮一行）或删除；对话本身也可编辑：悬浮某条用户消息会出现
**编辑并重发**，它会把会话分叉到这条消息之前，并在分叉里跑修改后的提示词——**原会话
原样不动**。输入框里的**模型选择器**数据来自 `GET /api/models`，因此
`MICRO_MODELS=model-a,model-b scripts/dev.sh` 就能列出多个模型。

## 种子是一个冻结的 tag

| ref | 它是什么 |
|---|---|
| [`seed-v1`](https://github.com/AlexZhangUPUPUP/micro-harness/tree/seed-v1) | **极简种子** —— `src/` 下六个文件，零依赖、无构建步骤，Node ≥ 22.18 直接运行。已冻结：那份可以从头读到尾的参考实现，不再变动。 |
| `main`（当前分支） | **平台** —— `packages/{kernel,core,server,gui}`：插件内核、事件驱动核心、多 agent 编排、服务端、CLI 与 GUI，沿种子的设计长出来。 |

种子没有被复制一份——P0 是**把那些文件搬进** `packages/core`，再在它们周围长出平台。
把原作保留成 tag 而不是第二条分支，意味着只有**一条开发主线**（不用把 README 维护两遍、
不会有两份同名文件各自漂移），同时那份可读的原作依然可浏览、且不可变。

平台整体设计（插件内核、组合方式、服务端、GUI、MCP/ACP）见
**[ARCHITECTURE.md](ARCHITECTURE.md)**，长期规划见 **[ROADMAP.md](ROADMAP.md)**。

## License

MIT
