import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Harness, EventHub, SessionFile, createCheckpoint, estimateRequestTokens, toolDefs,
  type ChatMessage, type Provider, type TaggedEvent, type Tool } from '../../../packages/core/src/index.ts'
import { gradeAnswer } from './grade.ts'
import { UsageObserver, EvaluationBudget } from './provider.ts'
import type { EvalConfig } from './config.ts'
import type { AttemptResult, ContextMode, ContextScenario, ScenarioStage, StageResult } from './types.ts'

const SYSTEM = '你正在继续一个合成项目交接任务。历史 STATE key=value 是可核查状态，明确的新值覆盖旧值。遵守历史约束。最终只输出请求的 JSON 字段，所有值均为字符串；缺少依据写 unknown，不得猜测。不要从字段名推断随机标识。'
const TOOL_CAP = 12000
const SAFETY = 128

/** 所有工具均为无副作用替身，不提供遗漏事实或访问真实工作区。 */
export function evaluationTools(): Tool[] {
  return ['read_file', 'run_completed_tests', 'publish'].map((name) => ({ name,
    description: name === 'read_file' ? '读取额外资料；没有提供历史丢失信息的恢复能力。'
      : name === 'publish' ? '模拟发布动作；只有历史明确授权才可调用。' : '模拟重新执行测试；遵守历史中的已完成状态。',
    parameters: { type: 'object', properties: {} },
    // 模拟副作用仅记在工具调用事件中，绝不执行 shell、网络或项目写入。
    async run() { return { output: 'No additional state is available. This simulated invocation was recorded.' } },
  }))
}

/** 一次尝试的运行态不包含评分期望，提供方仅接收 Harness 请求。 */
interface AttemptState {
  harness: Harness
  events: TaggedEvent[]
  tools: Tool[]
  provider: Provider
  config: EvalConfig
  mode: ContextMode
  trace: string
}

/** 每次启动沿用同一配置，输出预留与安全余量不随基线窗口变化。 */
function startHarness(state: Omit<AttemptState, 'harness'>): Harness {
  const hub = new EventHub()
  hub.on((event) => { state.events.push(event); appendFileSync(state.trace, JSON.stringify(event) + '\n') })
  return new Harness({ provider: state.provider, model: state.config.report.model, cwd: path.dirname(state.trace),
    systemPrompt: SYSTEM, tools: state.tools, hub, maxSteps: 4, maxToolOutput: TOOL_CAP,
    maxContextTokens: state.mode === 'full-history' ? state.config.report.baselineBudget : state.config.report.budget,
    contextOutputReserveTokens: state.config.report.outputTokens, contextSafetyMarginTokens: SAFETY,
    compact: state.mode === 'full-history' ? 'drop-middle' : state.mode,
    startSeq: state.events.reduce((max, event) => Math.max(max, event.seq), 0),
  })
}

/** 真实模式限定文本模型；图片仅由离线组验证序列化与恢复机制。 */
function fixtureHistory(history: ChatMessage[], config: EvalConfig): ChatMessage[] {
  if (config.report.backend === 'mock') return structuredClone(history)
  return history.map((message) => ({ ...structuredClone(message), content: Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'text') : message.content }))
}

/** 将同一固定历史记入日志，再走真实恢复和 prepare 路径施加压力。 */
function seedStage(state: AttemptState, stage: ScenarioStage): number {
  const messages = [...state.harness.messages, ...fixtureHistory(stage.history, state.config)]
  state.harness.log.emit({ type: 'context.checkpoint', checkpoint: createCheckpoint(messages, TOOL_CAP) })
  state.harness.restore(state.events)
  return estimateRequestTokens([...state.harness.messages, { role: 'user', content: stage.prompt }], toolDefs(state.tools))
}

/** 从磁盘事件建立新实例，逐项核对恢复窗口后才继续下一阶段。 */
function restart(state: AttemptState): boolean {
  const before = structuredClone(state.harness.messages)
  const persisted = SessionFile.read(state.trace)
  state.harness = startHarness(state)
  state.harness.restore(persisted)
  return JSON.stringify(before) === JSON.stringify(state.harness.messages)
}

/** 只记录本阶段实际压缩和新工具调用，历史注入不算重复执行。 */
function stageEvidence(events: TaggedEvent[]) {
  const trims = events.filter((event) => event.event.type === 'context.trim')
    .map((event) => event.event as Extract<TaggedEvent['event'], { type: 'context.trim' }>)
  const request = events.find((event) => event.event.type === 'model.request')?.event
  return { strategies: trims.filter((event) => event.dropped > 0 || event.strategy === 'summarize').map((event) => event.strategy),
    inputAfter: request?.type === 'model.request' ? request.tokens : 0,
    calls: events.filter((event) => event.event.type === 'tool.call').map((event) =>
      (event.event as Extract<TaggedEvent['event'], { type: 'tool.call' }>).name) }
}

/** 每阶段保留结果与错误，失败不会抹掉此前的真实证据。 */
async function runStage(state: AttemptState, stage: ScenarioStage, index: number, forbiddenTools: string[]): Promise<StageResult> {
  const restored = stage.restart === true
  const restoreMatches = restored ? restart(state) : null
  const inputBefore = seedStage(state, stage)
  const offset = state.events.length
  let answer = ''
  let error: string | undefined
  try {
    answer = await state.harness.send(stage.prompt)
  } catch (failure) {
    // 不将模型服务错误伪装成记忆失败，评分与执行状态分别保存。
    error = String((failure as Error).message).split(state.config.apiKey || '\0').join('[REDACTED]')
  }
  const evidence = stageEvidence(state.events.slice(offset))
  return { stage: index + 1, answer, inputBefore, inputAfter: evidence.inputAfter,
    retainedRatio: inputBefore ? evidence.inputAfter / inputBefore : 1,
    trimStrategies: evidence.strategies, restored, restoreMatches,
    grade: gradeAnswer(answer, stage, evidence.calls, forbiddenTools), ...(error ? { error } : {}) }
}

/** 压缩目标未实际发生或基线被裁剪时，样本只能标 invalid。 */
export function validityIssues(mode: ContextMode, stages: StageResult[], expectedStages: number): string[] {
  const issues: string[] = []
  const strategies = stages.flatMap((stage) => stage.trimStrategies)
  if (stages.length !== expectedStages) issues.push('not all stages completed')
  if (mode === 'full-history' && strategies.length) issues.push('full-history baseline was compacted')
  if (mode !== 'full-history' && strategies.length < 2) issues.push('fewer than two effective compactions')
  if (mode !== 'full-history' && stages.filter((stage) => stage.trimStrategies.length > 0).length < 2) {
    issues.push('compaction did not span two distinct stages')
  }
  if (mode === 'summarize' && strategies.some((strategy) => strategy !== 'summarize')) issues.push('summary strategy fell back to dropping')
  if (mode === 'summarize' && strategies.filter((strategy) => strategy === 'summarize').length < 2) issues.push('summary was not adopted twice')
  if (mode === 'summarize' && stages.filter((stage) => stage.trimStrategies.includes('summarize')).length < 2) {
    issues.push('summary adoption did not span two distinct stages')
  }
  if (stages.some((stage) => stage.restoreMatches === false)) issues.push('restored window differs from persisted working state')
  return issues
}

/** 运行单个 seed/mode；提供方包装器与评分器严格分离。 */
export async function runAttempt(
  config: EvalConfig, scenario: ContextScenario, mode: ContextMode, run: number,
  baseProvider: Provider, budget: EvaluationBudget,
): Promise<AttemptResult> {
  const started = Date.now()
  const trace = path.join(config.outDir, `${scenario.id}-${run}-${mode}.jsonl`)
  mkdirSync(config.outDir, { recursive: true })
  // 已存在结果必须显式换目录，防止混入上次运行的日志。
  writeFileSync(trace, '', { flag: 'wx' })
  const observer = new UsageObserver(config.pricing)
  const setup = { events: [] as TaggedEvent[], tools: evaluationTools(), config, mode, trace,
    provider: observer.wrap(baseProvider, budget, config.report.requestTimeoutMs) }
  const state: AttemptState = { ...setup, harness: startHarness(setup) }
  const stages: StageResult[] = []
  for (const [index, stage] of scenario.stages.entries()) {
    const result = await runStage(state, stage, index, scenario.forbiddenTools)
    stages.push(result)
    if (result.error) break
  }
  const issues = validityIssues(mode, stages, scenario.stages.length)
  const error = stages.find((stage) => stage.error)?.error
  const status = error ? 'error' : issues.length ? 'invalid' : stages.every((stage) => stage.grade.passed) ? 'pass' : 'fail'
  return { scenario: scenario.id, title: scenario.title, seed: scenario.seed, run, mode,
    backend: config.report.backend, status, stages, metrics: observer.metrics(Date.now() - started),
    validityIssues: issues, traceFile: trace, ...(error ? { error } : {}) }
}
