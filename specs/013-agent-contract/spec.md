# 013 多 Agent 契约

目标：让委派拥有目标、输入范围、权限、产物、验收条件和截止条件，父任务独立核验子任务结果，取消和 race 不遗留后台修改。验收覆盖同文件冲突、超限、假成功和合并后验证失败。

已落地 AgentResult 的结构化终态，以及 task 工具对目标、验收条件、预期产物和确定性验收命令的契约透传。父任务会通过 verify 工具执行声明的检查，避免把子 Agent 的自然语言回复误当成验收通过。

## 当前验收边界

- `goal`、`acceptance`、`artifacts` 会随委派结果返回并显示在摘要中。
- `checks` 会由父任务独立执行，全部通过才会得到 `verification: passed`，任一失败得到 `failed`。
- `artifacts` 会在当前工作区逐项检查存在性，并与 checks 一起决定验收结果。
- 未声明检查时，结果保持 `verification: unverified`；这不等同于验收通过。
