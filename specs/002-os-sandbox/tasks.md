# 执行清单

- [x] 定义 `Sandbox` 接口与 `detectSandbox`。
- [x] macOS Seatbelt profile 生成 + 单元测试。
- [x] Linux bwrap 参数生成 + 单元测试。
- [x] `ToolContext.sandbox` 注入（CLI / Harness / AgentRunner / server / ACP）。
- [x] `bash` 工具执行前包装命令。
- [x] `tool.call` 记录 `sandbox` 类型（Trace/Inspector 的专门展示留给 M3）。
- [x] `off` 行为不变，既有测试全绿。
- [x] `require` 缺失工具时 fail closed；`auto` 回退有明确警告。
- [x] 平台可用时的写入/断网集成测试（macOS）。
- [x] README 限制一节更新（中英）。
- [x] 全量测试、类型检查（文档站构建随 M3）。
- [x] M3：`GET /api/sandbox`、顶栏沙箱徽章、审批卡与 Trace 显示 `sandbox`、README 配置表补充 `MICRO_SANDBOX`。

## 验证记录

- 平台：macOS 26.6.2，`/usr/bin/sandbox-exec` 可用。
- profile：`deny default` + `process*` + `process-exec*` + `file-read*`；写根 = cwd（含 realpath）+ `/tmp` + `/private/tmp` + `/dev`；`--sandbox-net` 时才加 `network*`。
- 实测：写 `cwd` 成功；写工作区外失败（`Operation not permitted`）；默认断网时 `curl` 失败。
- `detectSandbox`：`off` 不包装；`require` 缺原语抛错；`auto` 回退并给出 notice。
- 测试：`bun test` **219 通过 / 0 失败**；`bun run typecheck` 通过。
- Linux bwrap：参数（`--ro-bind / /`、bind 工作区、`--unshare-net`、`--die-with-parent`）与检测（缺 bwrap / userns 不可用）有单测。
- Linux 容器实测（`oven/bun:1` + bubblewrap 0.9.0，`bun test packages/core/test/sandbox.test.ts`）：5 pass / 1 skip（seatbelt 在 Linux 跳过）/ 0 fail；bwrap 集成用例验证了「写工作区成功、写 /root 被拒、默认断网」。
