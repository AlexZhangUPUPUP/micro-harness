# 实施计划

1. 扩展 Core 事件契约并在 Harness 工具执行边界发出状态事件。
2. 让 Server ApprovalBroker 监听运行取消信号并清理定时器与监听器。
3. 在 GUI derive 层按工具调用 ID 合并状态，Transcript 展示取消与未知状态。
4. 运行 Core/Server 测试、类型检查和 GUI 构建。

后续迭代再把 AbortSignal 深入 shell/MCP 子进程，并增加资源锁和幂等执行键。
