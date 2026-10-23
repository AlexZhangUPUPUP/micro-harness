# 009 执行治理

## 目标

让每次工具调用都能被实时界面、SSE 回放和审计逻辑准确理解，并在运行取消时结束审批等待。

## 范围

- 为工具调用增加 planned、approved、started、succeeded、failed、cancelled、unknown 状态事件。
- 审批等待绑定当前运行的 AbortSignal，取消后立即释放等待。
- GUI 工具卡片按状态显示运行、取消和未知副作用。

## 约束

- 现有 `tool.call` 和 `tool.result` 事件保持兼容。
- 外部进程已经启动后被取消时标记 `unknown`，不声称副作用一定没有发生。
