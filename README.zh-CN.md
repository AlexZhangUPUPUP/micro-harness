<h1 align="center">micro-harness</h1>

<p align="center"><strong>让模型执行编码任务，也让执行过程清晰可见。</strong></p>
<p align="center">本地运行 · 多 Agent 协作 · 代码改动审阅 · CLI 与 Web 界面</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="https://alexzhangupupup.github.io/micro-harness/">文档站</a>
</p>

<p align="center">
  <a href="https://github.com/AlexZhangUPUPUP/micro-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AlexZhangUPUPUP/micro-harness/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Bun 1.1+" src="https://img.shields.io/badge/Bun-1.1+-black?style=flat-square&logo=bun">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square"></a>
</p>

micro-harness 是一个用 TypeScript 构建的编码 Agent 运行时。接入兼容 OpenAI Chat Completions 的模型服务后，它可以读取项目、修改文件、调用工具，并把复杂任务交给多个子 Agent。

你可以直接用它处理本地项目，也可以从源码理解一个编码 Agent 如何工作：从模型调用、工具执行到上下文管理，运行过程都有对应的代码与事件记录。

## 为什么使用它

- **把协作过程展开。** 查看主 Agent 如何分派任务，以及每个子 Agent 的状态、token 用量与成本。
- **把改动留给审阅。** 开启 Git worktree 隔离后，在 Changes 面板查看各子 Agent 的 diff，逐块接受或拒绝改动。
- **把模型调用看清。** 在 Trace 中检查事件与回放，在 Inspector 中查看每轮的系统提示词、消息和工具信息。

<p align="center">
  <img src="docs/gui-zh.png" alt="micro-harness 中文界面：会话列表、对话与 Agent 运行详情" width="1100">
</p>

<p align="center"><em>在一个界面里提交任务、跟踪执行、查看结果。</em></p>

[快速开始](#快速开始) · [CLI 与编辑器](#cli-与编辑器) · [多-agent-协作](#多-agent-协作) · [配置与运行边界](#配置与运行边界) · [架构与文档](#架构与文档) · [开发与贡献](#开发与贡献)

## 快速开始

需要 [Bun](https://bun.sh) ≥ 1.1，以及模型服务的 API Key。使用 worktree 隔离时还需要 Git，目标项目应为 Git 仓库。

### 1. 下载并配置模型

```bash
# 下载项目并安装依赖。
git clone https://github.com/AlexZhangUPUPUP/micro-harness.git
cd micro-harness
bun install

# 以 DeepSeek 为例，替换为你自己的 API Key。
export MICRO_BASE_URL=https://api.deepseek.com
export MICRO_API_KEY=your-api-key
export MICRO_MODEL=deepseek-chat
```

使用其他兼容服务时，同时更换地址、Key 和模型 ID；例如 OpenAI 的地址为 `https://api.openai.com/v1`。配置字段可参考 [.env.example](.env.example)。

### 2. 启动 Web 界面

```bash
# 首次体验使用工作区权限：允许内置文件工具读写，不开放 shell。
MICRO_PERMISSION=workspace bun run ui
```

首次启动会构建界面，然后自动打开浏览器，默认地址为 `http://127.0.0.1:8787`。端口被占用时会选择其他端口，以终端打印的地址为准；按 `Ctrl-C` 停止服务。

输入一个简单任务：

> 创建 hello.txt，写入 hello from micro-harness，然后读取文件并告诉我内容。

完成后，工作目录中应出现 `hello.txt`，对话里可以看到文件写入、读取和最终回复。默认工作目录是启动命令时所在的目录；启动信息中的 `cwd` 会显示实际位置。

### 3. 用于自己的项目

在 micro-harness 仓库中运行，指定目标项目的绝对路径：

```bash
# 将路径替换为你的项目目录。
MICRO_CWD=/absolute/path/to/your-project MICRO_PERMISSION=workspace bun run ui
```

也可以安装两个启动命令：

```bash
# 默认安装到 ~/.local/bin；该目录需要在 PATH 中。
./scripts/install.sh

# 进入目标项目，再启动界面。
cd /absolute/path/to/your-project
MICRO_PERMISSION=workspace microh
```

`micro-harness` 是编译后的 CLI；`microh` 是指向当前源码仓库的 Web 启动脚本，仍需要 Bun 和该仓库。

## CLI 与编辑器

### 在终端中使用

在仓库根目录运行：

```bash
# 执行一次任务，或进入交互模式。
bun start "阅读项目，概括入口文件和主要模块"
bun start

# 显式开放 shell，并在 shell 调用前要求确认。
bun start --allow-bash --approval auto-edit "运行相关测试，分析失败原因"

# 指定目标项目。
bun start --dir /absolute/path/to/your-project "解释这个项目的结构"
```

安装后可用 `micro-harness` 替代 `bun start`。完整参数见 `bun start --help`；交互模式输入 `/help`，可查看命令、提示词模板与 skills 入口。

### 通过编辑器使用

项目提供 ACP（Agent Client Protocol）入口，让支持该协议的编辑器驱动 Agent：

```bash
# 通过包装脚本启动，适合由编辑器调用。
/absolute/path/to/micro-harness/scripts/acp.sh
```

<details>
<summary>Zed 自定义 Agent 配置示例</summary>

将下面的路径替换为本机仓库的绝对路径。包装脚本会读取 `~/.micro-harness/env`；没有可用 Key 时，还会尝试读取 `~/.pi/agent/auth.json` 中的 DeepSeek Key。

```json
{
  "agent_servers": {
    "micro-harness": {
      "type": "custom",
      "command": "/absolute/path/to/micro-harness/scripts/acp.sh",
      "args": []
    }
  }
}
```

在 Agent Panel 中选择 `micro-harness` 新建会话。客户端声明文件读写能力时，Agent 可通过编辑器读取和修改文件，包括未保存的缓冲区；目录列表仍从本地磁盘读取。

</details>

## 多 Agent 协作

主 Agent 通过 `task` 工具分派工作。每个子 Agent 使用独立的对话上下文，接收任务描述，并将最终结果返回给主 Agent。它适合拆分代码调研、独立模块实现或多种方案的探索。

**上下文隔离默认存在，文件隔离需要另行开启。** 要让子 Agent 在各自的 Git worktree 中工作：

```bash
# 在 Git 项目上启用隔离，并打开 Web 界面。
MICRO_CWD=/absolute/path/to/your-project MICRO_ISOLATE=1 MICRO_PERMISSION=workspace bun run ui

# CLI 中使用对应参数，完成后打印 Agent 树。
bun start --dir /absolute/path/to/your-project --isolate --tree "将任务拆分给子 Agent，分别处理后汇总"
```

开启后，可以在 Agents 面板跟踪执行，在 Changes 面板检查各自的 diff，选择要应用的代码块。提示词可以描述如何分工，实际是否调用子 Agent 由模型决定。

| 代码改动审阅 | 模型调用检查 |
|---|---|
| ![逐块审阅子 Agent 的代码改动](docs/gui-hunks.png) | ![检查模型调用信息](docs/gui-inspector.png) |

CLI 还提供 `--max-depth`、`--max-concurrency`、`--agent-timeout`、`--agent-max-tokens` 和 `--agent-max-cost`，用于限制子 Agent 的执行规模。

## 配置与运行边界

| 配置 | 用途 |
|---|---|
| `MICRO_BASE_URL` / `MICRO_API_KEY` / `MICRO_MODEL` | 模型服务地址、凭证与模型 ID |
| `MICRO_CWD` | Web 服务的工作目录；CLI 使用 `--dir` |
| `MICRO_MODELS` | Web 模型选择器中的模型 ID，以逗号分隔 |
| `MICRO_PERMISSION` | Web 权限预设：`read-only`、`workspace`、`full`、`auto-review` |
| `MICRO_ISOLATE=1` | 为子 Agent 请求 Git worktree 隔离；CLI 使用 `--isolate` |
| `MICRO_DATA_DIR` | Web 会话与索引存储目录，默认 `~/.micro-harness` |
| `MICRO_HOST` / `MICRO_PORT` / `MICRO_SERVER_TOKEN` | 服务监听地址、起始端口与 API 鉴权 |
| `MICRO_WEB` | Web 服务内置联网工具：`off`、`fetch`、`search`、`all`，默认 `all` |
| `MICRO_SEARCH_PROVIDER` | 默认搜索引擎：`bing`、`baidu`、`bocha`、`searxng` |
| `MICRO_PRICE_INPUT` / `MICRO_PRICE_OUTPUT` / `MICRO_PRICE_INPUT_CACHED` | 每百万 token 的美元价格，用于成本估算 |

模型费用由所接入的服务商收取。成本显示依赖配置的价格与服务商返回的用量；图片输入需要所选模型支持。

**权限。** `bun run ui` 与 `microh` 默认使用 `full`，上手示例显式改为 `workspace`。CLI 默认不允许 shell，需传入 `--allow-bash`；`--approval` 决定工具调用是否需要批准。直接启动 server 入口时默认使用 `workspace`。当前 Web 主 Agent 的 shell 权限传递仍有限制，需要运行 shell 时可使用上面的 CLI 入口；权限过滤也尚不能完整约束第三方 MCP 工具。

**隔离。** 文件工具的路径检查与 Git worktree 用于限制操作范围、分离代码改动，不提供操作系统级沙箱。当前符号链接仍可能指向目录外；worktree 创建失败时会退回共享目录，应检查实际的 worktree 状态。

### 外部工具与联网

通过 MCP（Model Context Protocol）接入外部工具，支持 stdio 与 HTTP。配置在启动时加载，修改后需要重启。下面是 `.micro-harness/mcp.json` 的最小示例；也支持 `.mcp.json`、`~/.micro-harness/mcp.json` 或 `MICRO_MCP_CONFIG` 指定路径。

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "your-mcp-server",
      "args": []
    }
  }
}
```

工具以 `<server>__<tool>` 命名；`GET /api/mcp` 可查看连接状态。Web 服务内置 `web_search` 与 `web_fetch`，可通过界面的联网开关和搜索引擎选择器调整。使用 Bocha 需要 `BOCHA_API_KEY`，使用 SearXNG 需要 `MICRO_SEARXNG_URL`。

## 架构与文档

核心运行时负责“请求模型 → 执行工具 → 把结果交回模型”的循环，并发出事件。服务端将事件保存并推送到浏览器，界面据此展示对话、Agent 树与运行详情。

| 目录 | 职责 |
|---|---|
| [`packages/core`](packages/core) | Agent 循环、工具、上下文管理、多 Agent、CLI、MCP 与 ACP |
| [`packages/server`](packages/server) | HTTP API、SSE 事件推送、会话存储与全文检索 |
| [`packages/gui`](packages/gui) | React Web 界面、对话、轨迹、改动审阅与 Inspector |
| [`packages/web-mcp`](packages/web-mcp) | 内置搜索与网页读取工具 |

扩展模型、工具与文件系统时，分别实现 `Provider`、`Tool`、`FileSystem` 接口，在代码中显式组装。具体设计与取舍见以下文档：

| 文档 | 适合了解什么 |
|---|---|
| [架构说明](ARCHITECTURE.md) | 模块划分、数据流与设计基线 |
| [设计对比](docs/design-comparison.zh-CN.md) | 与其他 harness 的设计对照，以及采用或舍弃某种机制的原因 |
| [评测说明（英文）](scripts/evals/README.md) | 任务集、评分方法、上下文实验与评测局限 |
| [路线图](ROADMAP.md) / [构建记录](PROGRESS.md) | 项目演进与阶段记录；历史状态以当前代码为准 |
| [极简种子 seed-v1](https://github.com/AlexZhangUPUPUP/micro-harness/tree/seed-v1) | 从六个源码文件理解最初的 Agent 循环；该版本使用 Node ≥ 22.18 |

## 开发与贡献

```bash
# 基础检查：测试、类型检查与离线功能验证。
bun test
bun run typecheck
bun run verify

# 使用脚本化模型运行评测，不调用真实模型。
bun run eval:mock

# 构建文档站与 Web 界面。
bun run docs:build
cd packages/gui && bun run build
```

在仓库根目录运行 `bun run dev`，可分别启动 API 服务与 Vite preview；它服务构建产物，不提供源码热更新。需要前端热更新时，在 API 已运行的情况下进入 `packages/gui` 执行 `bun run dev`，并按 [Vite 配置](packages/gui/vite.config.mts) 设置后端地址。

欢迎提交 issue 与 PR。请说明要解决的问题、预期行为和验证方式；行为修改应带相关测试。真实模型评测会调用外部服务并产生费用，运行方式与限制见[评测说明](scripts/evals/README.md)。

## 许可与致谢

采用 [MIT License](LICENSE)。最初的种子源自 [PiStudio](https://github.com/AlexZhangUPUPUP/PiStudio)，worktree 与合并队列的实现也延续了其中的设计。
