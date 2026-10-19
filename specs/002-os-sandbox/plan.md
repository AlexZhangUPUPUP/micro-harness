# 实现与验证计划

1. 新增 `packages/core/src/sandbox.ts`：`Sandbox` 接口、`detectSandbox(mode)`、Seatbelt profile 生成、bwrap 参数生成；全部为纯函数，便于单测。
2. 把 `sandbox` 放进 `ToolContext`，由 `Harness` / `AgentRunner` / server 的 `build()` 注入；`bash` 工具的 `run` 在执行前调用 `wrap`。
3. CLI 增加 `--sandbox=off|auto|require` 与 `MICRO_SANDBOX`；server 从环境读取并透传。
4. 事件：`tool.call` 增加 `sandbox` 字段；Trace/Inspector 展示；模型可见输出不变。
5. 单测：profile/参数拼装、`require` 缺失工具时 fail closed、`auto` 回退警告、`off` 行为不变。
6. 集成测试（平台可用时）：写 `cwd` 成功、写外部失败、默认断网。
7. 文档：README 的限制一节替换为实际能力与剩余边界；`specs/002` 的验收项逐条勾选。
8. 全量 `bun test`、`bun run typecheck`、`bun run docs:build`；只在分支上提交，不直接改 `main`。

不引入新依赖（`bwrap` 为系统可选工具），不改变现有权限预设语义。
