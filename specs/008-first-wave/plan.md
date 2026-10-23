# 实施计划

1. 扩展 `task/plan.ts` 的生命周期状态和修订校验。
2. 增加 `runtime/RunBudget`，接入 Harness、AgentRunner 和 Server。
3. 将父级 AbortSignal 传递到 `task` 工具和子 Agent。
4. Server 在 Run 开始、异常、取消和自然返回时写入任务状态。
5. GUI 展示等待验证并提供显式完成操作。
6. 用确定性测试覆盖预算共享、任务状态迁移和取消生命周期。

每个步骤保持现有事件格式兼容，未验证完成不改变为成功。
