# 实施计划

## 结构

专项代码放在 `scripts/evals/context/`，沿用现有 Bun/TypeScript、Harness、JSONL 与评测独立 tsconfig，不新增运行时依赖。

- types/scenarios/grade：固定实验接口、随机化任务事实和严格评分。
- config/provider：参数、环境配置、请求可见 mock、费用与用量观察。
- runner/run：真实 Harness 分阶段施压、重启、有效性检查和 CLI。
- report：JSON 原始数据与 Markdown 汇总，明确 unknown 与样本限制。

## 分工

主 Agent 负责实验执行、Provider 观察、CLI、规格与整合；场景 Agent 负责刺激和评分；报告 Agent 负责契约与报告；方法审查 Agent 只读检查公平性、答案泄露和有效性。

## 验证顺序

先通过场景、评分、mock 反事实、缺失 usage、报告和参数回归，再运行离线 4 场景 × 3 模式。有效性检查通过后，使用已有 DeepSeek 环境凭证做受限真实模型冒烟，并保存独立结果文件。
