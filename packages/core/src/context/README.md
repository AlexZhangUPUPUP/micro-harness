# Context 模块

本模块维护模型可见的工作窗口。完整事件日志是审计来源，工作窗口是实际请求输入；二者不要求包含同样数量的历史内容。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `manager.ts` | 消息加入、请求准备、usage 校准、预算检查、恢复与检查点 |
| `budget.ts` | 消息及工具定义粗估、工具结果头尾截断 |
| `normalize.ts` | 按调用 ID 补齐中断结果、移除孤儿及重复结果 |
| `compact.ts` | 按用户轮次与完整工具步骤裁剪、摘要空间分配 |
| `summarize.ts` / `selection.ts` | 记录优先选择、有界摘要输入、取消、超时及用量回调 |
| `task-state.ts` | 独立任务来源状态的恢复与有界历史证据投影 |
| `checkpoint.ts` | 版本校验、最新有效窗口定位与后缀事件恢复 |
| `types.ts` / `index.ts` | 共享契约与模块出口 |

旧的 `../context.ts`、`../compact.ts` 与包级导出继续兼容。新代码优先通过模块出口调用，不在 Harness 或 Server 内另写压缩算法。

## 运行过程

1. Harness 通过 `append` 提交原始消息；来源证据先交给独立的 [task 模块](../task/README.md)，工具输出在首次入窗时截断。
2. 每次请求前调用 `prepare(signal)`，规范工具消息并计算完整请求预算。
3. 必要时裁掉旧轮次或旧工具步骤；首轮过大时只优先保留原用户要求，不永久保留首轮全部工具历史。
4. `summarize` 策略将被移除内容压缩为交接摘要，生成失败可退回确定性裁剪；父请求取消必须向上传播。
5. 以 `changed` 判断窗口是否更换，摘要净删除数为零也需要应用。
6. 压缩后的完整请求仍超限时抛出 `ContextBudgetError`，不继续调用模型，也不静默截断系统规则或最新用户输入。

## 预算含义

`maxContextTokens` 现在表示完整请求的本地估算预算，包含输入、输出预留和安全余量。它不是精确 tokenizer 或提供方保证。

- 输入包含系统指令、文本、多模态粗估、工具 schema 与消息封装。
- 文本按 UTF-8 字节粗估，图像仍采用固定成本；真实图像费用可能因模型和尺寸而异。
- 默认输出预留为预算的 15%，最多 4096 tokens，至少 1 token；安全余量为 5%，最多 512 tokens。
- Harness 将输出预留传为请求级 `maxTokens`，Provider 已配置的更小上限仍有效。
- SDK 调用可用 `contextOutputReserveTokens` 和 `contextSafetyMarginTokens` 显式调整；旧 CLI `--max-context` 与 `MICRO_MAX_CONTEXT` 继续生效。
- 实际 `prompt_tokens` 高于静态估算时，偏差仅用于未改写的同一消息前缀；压缩、替换或恢复后失效。

摘要自身有总输入、输出及超时上限。输入优先选择可容纳的用户记录和短且不同的观察，按原始顺序输出完整 JSON 行；过长字段内部明确标记省略，不再统一截取每条消息前 2000 字符和整段头尾。该启发式仍可能遗漏长记录中的关键事实。

压缩时的任务证据投影单独占用同一请求预算，作为助手角色的历史引用提供；不将工具文本提升为系统指令。摘要的 usage 走现有费用统计并标记 `purpose: summary`；这不是跨 Agent 的共享预算账本。

## 检查点与恢复

Context Inspector 通过 `context.snapshot` 和 `context.compaction` 记录每次模型实际收到的窗口及压缩前后差异。SQLite/JSONL 只保存事件，Server 和 GUI 可据此实时回放、审查和导出 Markdown；原始用户输入与工具事件不会被压缩记录覆盖。

`context.checkpoint` 保存版本化消息窗口、当时的工具输出截断配置以及可选的 `taskState` 来源证据。压缩改变窗口、完整工具步骤完成及用户轮结束时记录，存储层只负责持久化事件。

恢复先定位当前 Agent 的最新有效检查点，再回放其后原始事件。旧日志没有检查点时从头恢复；未知或损坏检查点不作为窗口来源。

- 已存检查点直接复用原文，不重复截断工具结果。
- 后缀原始结果采用检查点记录时的截断配置；下一轮新结果使用当前配置。
- 系统消息始终使用当前项目规则，检查点不携带权限配置。
- 用户图像随原始用户事件和窗口保存。

`Harness.messages` 保留观察兼容性；业务接入使用 `Harness.restore(events)`，不直接修改该数组。

## 验证与边界

测试分别位于 `packages/core/test/context/`、`context-harness.test.ts`、旧 context/session/loop 用例和服务端 `context-resume.test.ts`。本次不引入远端 Responses 压缩、后台并发压缩或检索系统。
