# Context 专项评测

比较完整历史基线、`drop-middle` 和 `summarize`。每个场景包含三阶段：约束保留、中途纠正、已完成/待办，以及从磁盘恢复工作窗口。每个 seed 的三组共用事实、提问、工具定义和输出预算。

## 运行

```sh
# 离线替身只读取请求可见状态，验证机制和信息可见性。
bun run eval:context --mock

# 真实模型冒烟，使用现有 MICRO_*、OPENAI_* 或 DeepSeek 环境凭证。
bun run eval:context --runs=1 --max-requests=100 --max-cost=0.25

# 指定场景与全新的结果目录；参数统一使用 --name=value。
bun run eval:context --mock --scenarios=correction,restart --out-dir=/tmp/context-probe-new

# 只执行专项测试，不会调用真实模型。
bun test scripts/evals/context/test
bunx tsc -p scripts/evals/tsconfig.json --noEmit
```

默认小窗口 3200、完整历史窗口 32000、输出上限 256、安全余量 128 tokens。提供方温度固定为 0，工具结果上限统一为 12000 字符。每个运行编号只构造一套 fixture，三个模式使用同一个 seed；多次运行会轮换模式顺序。

真实调用仍使用项目现有 OpenAI-compatible Provider。`DEEPSEEK_API_KEY` 只作为默认 DeepSeek 地址的后备凭证，不读取或打印凭证文件。费用为配置价格或项目带日期快照的估算；未知模型必须显式设置 `MICRO_PRICE_INPUT` 和 `MICRO_PRICE_OUTPUT`，不能把无效费用上限当成保护。

`--timeout` 限制单次逻辑请求等待时间，`--max-requests` 限制整批 Provider 调用，`--max-cost` 在调用前预留预计费用。未知或超时用量继续占用额度，迟到完整响应仍结算。底层 HTTP 重试没有单独计数，本地 token 粗估不能保证实际计费绝不越过阈值。

## 输出与退出码

生成文件位于 `reports/context/<time>-<backend>/`，已从 Git 排除：

- `results.json`：原始配置、每次尝试、逐字段评分、实际策略和用量。
- `results.md`：从同一 JSON 明细计算的汇总。
- `<scenario>-<run>-<mode>.jsonl`：真实 Harness 事件及工作窗口。
- `summary-input-audit.json`：无网络的摘要输入确定性重建，定位事实是在输入选择、摘要输出还是答题阶段丢失；明确标注为事后重建，不能当作线上抓包。

存在 fail/error/invalid 时退出码为 1，失败结果仍然完整保存。尤其是作为负对照的 `drop-middle`，失败可能正是实验检测到的信息丢失，不能因此改评分器让它通过。参数和初始化失败使用退出码 2。已有尝试日志不会被覆盖，请使用新目录。

## 有效性与局限

- 完整历史组不得发生裁剪；压缩组至少在两个不同阶段实际压缩；摘要降级为删除时标 invalid。
- 最终提问仅给字段名，不重复给出答案；nonce 随 seed 改变。评分严格解析 JSON，逐字段比较，不能从说明文本中捞取关键词。
- mock 没有访问 expected 的接口；反事实测试要求替换可见事实时回答变化，删去事实时返回 unknown。mock 的语义能力仅限可见 `STATE` 记录，不能代表真实模型。
- 真实任务是合成上下文保持探针，不是仓库编码 benchmark；每组一次只能作为冒烟证据。
- restart 是同进程读取真实磁盘日志并创建新 Harness，校验窗口一致后继续请求，不声称操作系统进程重启。真实组仅发送文本；图片仅在离线组验证序列化恢复，不测视觉理解。
- Provider 的原始 usage 单独采集；缺失输入、输出或价格不能当作零成本。mock token 是本地估算，summary token 已包含在总 token 中。
- 固定首轮执行顺序、缓存命中和少量场景都会影响费用与耗时；完整历史基线失败时禁止将差异归因于压缩。

## 本轮发现

2026-10-22，`deepseek-chat`，固定 seed、每组一次：完整历史 4/4、drop-middle 0/4、summarize 1/4；12 次尝试均无 error/invalid。使用 48 次逻辑 Provider 调用，报告的总费用估算约 $0.02651。

摘要失败的首次信息丢失在事后确定性重建中均可追溯到摘要输入选择：原始历史中存在的新路由、测试凭据和产物状态，没有进入有界头尾摘要请求；后续窗口只能继续传播缺失或旧值。因此下一步应修摘要输入选择和任务状态保留，而不是用本轮结果声称结构化摘要已解决长任务记忆。
