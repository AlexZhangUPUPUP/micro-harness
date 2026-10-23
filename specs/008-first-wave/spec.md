# 第一波：任务生命周期与 Run 边界

## 目标

让一次任务执行具备可追踪的目标、运行状态、共享预算和取消传播；任务只有在验证记录全部通过后才能显式进入 `completed`。

## 范围

- Core：Task 生命周期、共享 RunBudget、父子 Agent 取消传播。
- Server：运行开始/结束更新任务状态，预算配置沿用现有 ServerOptions 和环境变量。
- GUI：任务状态、等待验证和显式完成入口。
- 不包含：工具资源冲突、artifact 独立存储、后台调度和远程团队能力。

## 不变量

1. 主 Agent、子 Agent 和摘要共享一次 Run 的成本/Token 预算。
2. 父 Run 取消后，子 Agent 不得继续模型调用或工具调用。
3. 正常模型返回只进入 `awaiting_verification`，不能自动进入 `completed`。
4. 任务状态更新使用 revision，旧 revision 不得覆盖新状态。
5. 预算、状态和失败原因通过事件/API 可恢复，不能只保存在 GUI 内存。
