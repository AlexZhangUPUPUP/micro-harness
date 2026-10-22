# 任务清单

- [x] 确认现有调用关系和问题复现，记录本批范围与验收标准。
- [x] 修复索引重建累计值并补充幂等回归用例。
- [x] 修复流式响应完整性、错误传播与资源释放并补充回归用例。
- [x] 修复会话切换期间的快照、订阅、权限与命令状态串扰并补充回归用例。
- [x] 复核各模块 diff、中文注释及新增修改函数长度。
- [x] 完成针对性测试、类型检查和 GUI 构建，记录结果与限制。

## 验证结果

- `bun test packages/server/test/store.test.ts`：8 通过，49 个断言。
- `bun test packages/core/test/streaming.test.ts`：最终版本 14 通过，38 个断言。
- `bun test packages/gui/test/sessionLifecycle.test.ts`：5 通过，13 个断言。
- `bun test packages/gui/test/permissionState.test.ts`：4 通过，19 个断言。
- `bun test packages/gui/test/permissionPicker.test.tsx`：1 通过，30 个断言。
- `bun scripts/verify-features.ts p5`：8/8 检查通过，包含真实流式客户端的本地服务调用。
- 根目录 `bun run typecheck`、GUI 类型检查与 `bun run build` 均通过。
- `git diff --check` 通过；未运行全量测试、真实模型请求或浏览器 E2E。
- 构建改写的已跟踪 dist 文件恢复到本批开始时版本，避免将生成产物混入源代码改动。
