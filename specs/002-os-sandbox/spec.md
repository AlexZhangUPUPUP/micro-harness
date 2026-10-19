# 002：操作系统级沙箱

## 目标

给 `bash` 工具加一层操作系统级约束：即使权限预设允许 shell，命令也只能读取必要路径、只能写工作区（以及显式允许的路径），默认不能联网。它是路径检查与 worktree 之外的**纵深防御**，不是权限模型的替代品。

## 背景

- 当前边界：文件工具做 `realpath` 前缀检查；子 Agent 可选 worktree。README 已声明这不是安全边界。
- 权限预设决定“工具是否存在、是否要审批”，不决定“进程能做什么”。
- Codex 等实现使用 Seatbelt / Landlock；这是本项目目前最实质的能力差距。

## 方案

### 抽象

在 `packages/core/src/sandbox.ts` 增加：

```ts
export interface Sandbox {
  readonly kind: 'none' | 'seatbelt' | 'bwrap'
  /** 把一条 shell 命令包装成受约束的调用。 */
  wrap(command: string, opts: { cwd: string; writeRoots: string[]; network: boolean }): { command: string; args: string[] }
}
export function detectSandbox(mode: 'off' | 'auto' | 'require'): Sandbox
```

`ToolContext` 增加可选的 `sandbox?: Sandbox`；`bash` 工具在执行前调用 `ctx.sandbox?.wrap(...)`，未配置时行为完全不变。

### macOS（Seatbelt）

- 通过 `sandbox-exec -p <profile> /bin/sh -c <command>` 执行。
- profile 基线：
  - `(deny default)`
  - `(allow process*)`、`(allow sysctl-read)`、`(allow file-read*)`
  - `(allow file-write* (subpath "<cwd>") (subpath "<worktree>") (subpath "/private/tmp") (subpath "/dev"))`
  - `network` 为 true 时加 `(allow network*)`，否则保持 deny。
- 检测：`sandbox-exec` 存在且可执行；macOS 已将其标记 deprecated，但当前版本仍可用，需在文档中注明。

### Linux（bubblewrap）

- 优先 `bwrap`：
  - `--ro-bind / / --bind <cwd> <cwd> --dev /dev --proc /proc --unshare-pid`
  - 网络：默认 `--unshare-net`；允许时去掉。
- `bwrap` 不存在时：`require` 直接报错不执行；`auto` 回退到无沙箱并发出明确警告（事件 + 工具输出首行），绝不静默。

### 配置

- CLI：`--sandbox=off|auto|require`（默认 `off`，第一版先 opt-in）。
- 环境：`MICRO_SANDBOX`。
- 服务器：`MICRO_SANDBOX` 透传到会话的 `ToolContext`。
- 写入根：主工作区 + 当前 worktree（隔离模式下）。

### 事件

`tool.call` 增加可选字段 `sandbox: 'seatbelt' | 'bwrap'`，不改变命令本身；`tool.result` 的模型可见文本不加沙箱提示（避免污染输出），只在 Trace/Inspector 显示。

## 场景与验收

1. **写入**：`--sandbox=require` 下，`bash` 写 `/tmp/outside` 被拒绝，写 `cwd` 成功。
2. **读取**：读取系统文件与工作区文件正常；`/etc/passwd` 等只读不受影响。
3. **网络**：默认 `curl` 失败；显式允许网络时可用。
4. **缺失工具**：无 `sandbox-exec` / `bwrap` 时，`require` 报错且不执行；`auto` 回退并明确警告，不静默。
5. **隔离模式**：worktree 路径在可写根内，子 Agent 能正常改自己的 worktree。
6. **兼容**：`off` 时行为与现有完全一致；既有 212 个测试全绿。
7. **记录**：Trace/Inspector 能看到本次调用使用的沙箱类型。

## 范围与边界

- 不做容器/虚拟机、不做 Windows、不实现完整 seccomp 策略。
- 不改变权限预设语义：预设仍决定工具与审批，沙箱只约束进程能力。
- MCP 工具与 `web_fetch` 不经过 shell，本轮不纳入（它们有自己的 SSRF/权限边界）。
- `sandbox-exec` 未来可能被移除；届时需要 bwrap 或容器作为替代。

## 风险

- macOS 的 Seatbelt 语法随版本变化，profile 需要按平台实测。
- Linux 上 `bwrap` 并非默认安装；`require` 模式必须 fail closed。
- 每条命令多一层包装进程，带来少量启动开销。
- 与 `worktree`、`/tmp`、`/dev` 的写入白名单需要逐项验证，避免误伤正常命令（如 `git`）。

## 阶段

1. 接口、检测、macOS profile、单元测试（profile 生成与参数拼装）。
2. Linux bwrap 实现与测试。
3. `auto` 默认策略评估、文档与限制更新。
4. 与 Codex 的沙箱行为做一次对照（写入根、网络、只读路径）。
