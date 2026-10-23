# 014 Provider 与互操作

MCP stdio 增加可选 `terminateOnAbort` 能力：取消长调用时终止独立进程组并关闭连接，后续调用必须重新连接，避免未知副作用被静默复用。

`McpConnection.reconnect()` 会创建全新传输并重新执行 initialize/tools-list，调用方可以在断连后显式恢复。

目标：声明 Provider、MCP、ACP 的能力、限制、取消、错误、usage 和恢复语义；未经验证的组合标记实验性。验收覆盖至少两种模型配置和 MCP/ACP 的异常、权限、输出限制与恢复。
