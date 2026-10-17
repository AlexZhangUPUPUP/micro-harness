<h1 align="center">micro-harness</h1>

<p align="center"><strong>Put models to work on code. See how the work gets done.</strong></p>
<p align="center">Run locally · Coordinate agents · Review changes · CLI and web interface</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://alexzhangupupup.github.io/micro-harness/">Documentation</a>
</p>

<p align="center">
  <a href="https://github.com/AlexZhangUPUPUP/micro-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AlexZhangUPUPUP/micro-harness/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Bun 1.1+" src="https://img.shields.io/badge/Bun-1.1+-black?style=flat-square&logo=bun">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square"></a>
</p>

micro-harness is a coding-agent runtime built with TypeScript. Connect a model service compatible with OpenAI Chat Completions to read projects, edit files, call tools, and delegate work to multiple agents.

Use it on a local project, or explore the source to understand how a coding agent works. Model calls, tool execution, and context management have corresponding code and event records you can inspect.

## Why use it

- **Follow the collaboration.** See how the main agent delegates work, with status, token usage, and cost for each sub-agent.
- **Review the changes.** Enable Git worktree isolation, inspect each sub-agent's diff in Changes, and accept or reject individual hunks.
- **Inspect model calls.** Browse events and replay in Trace, then examine each round's system prompt, messages, and tool information in Inspector.

<p align="center">
  <img src="docs/gui.png" alt="micro-harness: sessions, conversation, and agent execution details" width="1100">
</p>

<p align="center"><em>Submit a task, follow its execution, and inspect the result in one interface.</em></p>

[Quick start](#quick-start) · [CLI and editors](#cli-and-editors) · [Working with multiple agents](#working-with-multiple-agents) · [Configuration and boundaries](#configuration-and-boundaries) · [Architecture and documentation](#architecture-and-documentation) · [Development and contributing](#development-and-contributing)

## Quick start

You need [Bun](https://bun.sh) ≥ 1.1 and an API key for your model service. Worktree isolation also requires Git and a target project that is a Git repository.

### 1. Get the project and configure a model

```bash
# Clone the project and install dependencies.
git clone https://github.com/AlexZhangUPUPUP/micro-harness.git
cd micro-harness
bun install

# DeepSeek shown as an example; use your own key.
export MICRO_BASE_URL=https://api.deepseek.com
export MICRO_API_KEY=your-api-key
export MICRO_MODEL=deepseek-chat
```

For another compatible service, change the URL, key, and model ID together. For example, OpenAI uses `https://api.openai.com/v1`. See [.env.example](.env.example) for configuration fields.

### 2. Open the web interface

```bash
# Workspace permission: built-in file tools work, the shell stays closed.
MICRO_PERMISSION=workspace bun run ui
```

The first launch builds the interface and opens your browser, normally at `http://127.0.0.1:8787`. If the port is occupied, the launcher picks another one; use the URL printed in your terminal. Press `Ctrl-C` to stop.

Try a small task:

> Create hello.txt containing hello from micro-harness, then read the file and tell me its contents.

When it finishes, `hello.txt` should exist in the working directory, and the conversation should show the write, read, and final reply. The default working directory is where you launch the command; the startup output shows it as `cwd`.

### 3. Use it on your own project

From the micro-harness repository, pass the absolute path to your project:

```bash
# Replace with the path to your project.
MICRO_CWD=/absolute/path/to/your-project MICRO_PERMISSION=workspace bun run ui
```

Alternatively, install the two launch commands:

```bash
# Installs to ~/.local/bin, which must be on PATH.
./scripts/install.sh

# Enter the target project, then start the interface.
cd /absolute/path/to/your-project
MICRO_PERMISSION=workspace microh
```

`micro-harness` is the compiled CLI. `microh` is a web launcher pointing to this source checkout; it still needs Bun and the checkout.

## CLI and editors

### Work in the terminal

From the repository root:

```bash
# Run one task, or start interactive mode.
bun start "Read this project and summarize its entry points and main modules"
bun start

# Explicitly allow the shell, with an approval before each call.
bun start --allow-bash --approval auto-edit "Run the relevant tests and analyze failures"

# Point at the target project.
bun start --dir /absolute/path/to/your-project "Explain this project's structure"
```

After installation, replace `bun start` with `micro-harness`. Run `bun start --help` for the full options, or enter `/help` in interactive mode for commands, prompt templates, and skills.

### Connect an editor

The ACP (Agent Client Protocol) entry point lets a compatible editor drive the agent:

```bash
# Launch through the wrapper script, suitable for an editor.
/absolute/path/to/micro-harness/scripts/acp.sh
```

<details>
<summary>Example custom-agent configuration for Zed</summary>

Replace the path below with the absolute path to your checkout. The wrapper reads `~/.micro-harness/env`; if no key is available, it also tries the DeepSeek key in `~/.pi/agent/auth.json`.

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

Choose `micro-harness` in the Agent Panel to start a session. When the client advertises file read/write capabilities, the agent can access files through the editor, including unsaved buffers. Directory listings still use the local disk.

</details>

## Working with multiple agents

The main agent delegates through the `task` tool. Each sub-agent gets its own conversation context, receives a task description, and returns its final result. This is useful for code research, independent implementation tasks, or exploring alternatives.

**Conversation contexts are separate by default. File isolation is opt-in.** To give sub-agents separate Git worktrees:

```bash
# Enable isolation on a Git project and open the web interface.
MICRO_CWD=/absolute/path/to/your-project MICRO_ISOLATE=1 MICRO_PERMISSION=workspace bun run ui

# The CLI takes the same flags and prints the agent tree when done.
bun start --dir /absolute/path/to/your-project --isolate --tree "Delegate separate parts of the task to sub-agents, then summarize their results"
```

Follow execution in Agents and inspect each diff in Changes, where you can select individual hunks to apply. Prompts can request delegation; whether the task tool is called depends on the model.

| Review code changes | Inspect model calls |
|---|---|
| ![Review individual hunks from a sub-agent](docs/gui-hunks.png) | ![Inspect model call information](docs/gui-inspector.png) |

The CLI also exposes `--max-depth`, `--max-concurrency`, `--agent-timeout`, `--agent-max-tokens`, and `--agent-max-cost` to limit sub-agent execution.

## Configuration and boundaries

| Configuration | Purpose |
|---|---|
| `MICRO_BASE_URL` / `MICRO_API_KEY` / `MICRO_MODEL` | Model endpoint, credentials, and model ID |
| `MICRO_CWD` | Web server working directory; use `--dir` for the CLI |
| `MICRO_MODELS` | Comma-separated model IDs for the web model picker |
| `MICRO_PERMISSION` | Web preset: `read-only`, `workspace`, `full`, or `auto-review` |
| `MICRO_ISOLATE=1` | Request Git worktree isolation for sub-agents; use `--isolate` for the CLI |
| `MICRO_DATA_DIR` | Web session and index directory; defaults to `~/.micro-harness` |
| `MICRO_HOST` / `MICRO_PORT` / `MICRO_SERVER_TOKEN` | Bind address, starting port, and API authentication |
| `MICRO_WEB` | Built-in web tools on the server: `off`, `fetch`, `search`, or `all` (default) |
| `MICRO_SEARCH_PROVIDER` | Default search engine: `bing`, `baidu`, `bocha`, or `searxng` |
| `MICRO_PRICE_INPUT` / `MICRO_PRICE_OUTPUT` / `MICRO_PRICE_INPUT_CACHED` | USD per million tokens for cost estimates |

Your model provider charges for model usage. Displayed costs depend on your configured prices and the provider's usage reporting. Image input requires a model that supports it.

**Permissions.** `bun run ui` and `microh` default to `full`; the examples explicitly use `workspace`. The CLI disables shell execution unless you pass `--allow-bash`; `--approval` controls approval prompts. Starting the server entry point directly defaults to `workspace`. Shell permission propagation to the web session’s main agent is currently incomplete; use the CLI example above for shell tasks. Permission filtering also does not yet fully constrain third-party MCP tools.

**Isolation.** File path checks and Git worktrees help scope file operations and separate changes; they do not provide an operating-system sandbox. Symlinks can currently point outside the working directory, and worktree creation failures fall back to the shared directory. Check the actual worktree status.

### External tools and web access

Connect external tools through MCP (Model Context Protocol), using stdio or HTTP. Configuration is loaded at startup; restart after changing it. This is a minimal `.micro-harness/mcp.json` example. You can also use `.mcp.json`, `~/.micro-harness/mcp.json`, or a path supplied through `MICRO_MCP_CONFIG`.

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

Tools are named `<server>__<tool>`; `GET /api/mcp` reports connection status. The web server bundles `web_search` and `web_fetch`, with a live web toggle and search-engine picker in the interface. Bocha requires `BOCHA_API_KEY`; SearXNG requires `MICRO_SEARXNG_URL`.

## Architecture and documentation

The core runs the loop: request a model response, execute tools, and send the results back to the model. It emits events that the server persists and streams to the browser, where they drive the conversation, agent tree, and execution views.

| Directory | Responsibility |
|---|---|
| [`packages/core`](packages/core) | Agent loop, tools, context management, multiple agents, CLI, MCP, and ACP |
| [`packages/server`](packages/server) | HTTP API, SSE streaming, session storage, and full-text search |
| [`packages/gui`](packages/gui) | React interface, conversations, traces, change review, and Inspector |
| [`packages/web-mcp`](packages/web-mcp) | Built-in search and page-fetching tools |

Extend models, tools, and file access through the `Provider`, `Tool`, and `FileSystem` interfaces, then compose them explicitly in code. For the details and design decisions:

| Document | What to explore |
|---|---|
| [Architecture (Chinese)](ARCHITECTURE.md) | Module boundaries, data flow, and the design baseline |
| [Design comparison](docs/design-comparison.md) | Other harnesses, design choices, and the reasons behind them |
| [Evaluation guide](scripts/evals/README.md) | Tasks, grading, context experiments, and evaluation limits |
| [Roadmap](ROADMAP.md) / [Build log](PROGRESS.md) | Project evolution and milestones; current code takes precedence over historical status |
| [Minimal seed: seed-v1](https://github.com/AlexZhangUPUPUP/micro-harness/tree/seed-v1) | The original agent loop in six source files, running on Node ≥ 22.18 |

## Development and contributing

```bash
# Baseline checks: tests, type checking, offline feature verification.
bun test
bun run typecheck
bun run verify

# Run evals with a scripted model; no real model calls.
bun run eval:mock

# Build the docs site and the web interface.
bun run docs:build
cd packages/gui && bun run build
```

`bun run dev` at the repository root starts the API server and Vite preview separately. It serves built assets without source hot reload. For frontend hot reload, run the API, then execute `bun run dev` inside `packages/gui`, setting the backend address as described in the [Vite configuration](packages/gui/vite.config.mts).

Issues and pull requests are welcome. Explain the problem, expected behavior, and validation; include relevant tests for behavior changes. Real-model evaluations call external services and incur charges. See the [evaluation guide](scripts/evals/README.md) for commands and limitations.

## License and acknowledgments

Released under the [MIT License](LICENSE). The original seed grew out of [PiStudio](https://github.com/AlexZhangUPUPUP/PiStudio), whose designs also informed the worktree and merge queue implementations.
