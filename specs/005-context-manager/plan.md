# 实施计划

## 模块结构

- `types.ts`：共享类型与常量。
- `budget.ts`：文本、工具定义估算与工具输出截断。
- `normalize.ts`：按 call ID 规范工具消息组。
- `compact.ts`：确定性裁剪与有界摘要规划。
- `summarize.ts`：模型摘要、信号、超时和用量回调。
- `checkpoint.ts`：快照格式、校验与事件恢复。
- `manager.ts`：工作窗口状态、请求准备、usage 校准与预算失败。
- `index.ts`：模块公共出口；旧文件仅转发兼容导出。

## 接入

Harness 保留 `messages` 观察入口，内部所有修改走管理器。日志保存原始工具结果；在完整步骤边界与请求前保存 checkpoint。服务端调用 Harness.restore 恢复，session.ts 的旧恢复函数转发到 Context 模块。

## 分工

- 主 Agent：规格、Harness 与事件接入、兼容入口、请求级输出限额、整合验证。
- Context 算法 Agent：预算、配对、裁剪与摘要及独立测试。
- Context 状态 Agent：manager、checkpoint 与恢复及独立测试。
- 服务端 Agent：续聊接入与针对性 HTTP 回归。

## 验证

覆盖首轮膨胀、单消息摘要、超长摘要、不可裁输入、中文、工具定义、多工具乱序与中断、摘要取消/用量、重复恢复和跨服务实例续聊。检查实际模型请求内容与 checkpoint 一致，不仅断言消息数量。
