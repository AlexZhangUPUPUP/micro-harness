import { readFileSync } from 'node:fs'
import { ContextManager, makeSummarizer, type ChatMessage, type Provider, type TaggedEvent } from '../../../packages/core/src/index.ts'
import { evaluationTools } from './runner.ts'
import type { AttemptResult, ContextReport } from './types.ts'

/** 离线重建摘要输入，用于定位失败事实在何处消失，绝不调用真实模型。 */
export interface SummaryAudit {
  basis: string
  networkCalls: 0
  inputs: Array<{ scenario: string; stage: number; messages: ChatMessage[] }>
  misses: Array<{ scenario: string; stage: number; field: string; sourceVisible: boolean;
    summaryInputVisible: boolean; retainedVisible: boolean; location: string }>
}

/** 文本检查仅用于事后诊断，不参与原始任务评分或模型回答构造。 */
function contains(messages: ChatMessage[], expected: string): boolean {
  return JSON.stringify(messages).includes(expected)
}

/** 使用同一预算、工具定义和摘要实现还原已经发生的摘要请求。 */
async function reconstructInput(events: TaggedEvent[], index: number, report: ContextReport): Promise<ChatMessage[]> {
  let captured: ChatMessage[] = []
  const recorder: Provider = { name: 'offline-audit', async chat(request) {
    captured = structuredClone(request.messages)
    return { message: { role: 'assistant', content: 'audit placeholder' } }
  } }
  const system = events.slice(index).find((event) => event.event.type === 'model.request')?.event
  if (system?.type !== 'model.request') throw new Error('Missing actual model request after summary')
  const manager = new ContextManager({ systemPrompt: system.system, maxTokens: report.config.budget,
    outputReserveTokens: report.config.outputTokens, safetyMarginTokens: 128, maxToolOutput: 12000,
    tools: evaluationTools().map((tool) => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters,
    } })), compact: 'summarize', summarizer: makeSummarizer(recorder, report.config.model,
      { maxInputTokens: Math.floor(report.config.budget * 0.8) }),
  })
  manager.restore(events.slice(0, index))
  await manager.prepare()
  return captured
}

/** 对每阶段恰好一次摘要的记录逐项检查，否则拒绝猜测对应关系。 */
async function auditAttempt(attempt: AttemptResult, report: ContextReport, audit: SummaryAudit): Promise<void> {
  if (!attempt.traceFile || attempt.stages.some((stage) => stage.trimStrategies.length !== 1)) return
  const events = readFileSync(attempt.traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TaggedEvent)
  const indices = events.flatMap((event, index) => event.event.type === 'usage' && event.event.purpose === 'summary' ? [index] : [])
  if (indices.length !== attempt.stages.length) return
  for (const [ordinal, index] of indices.entries()) {
    const input = await reconstructInput(events, index, report)
    const actual = events.slice(index).find((event) => event.event.type === 'model.request')!.event
    if (actual.type !== 'model.request') continue
    const sourceCheckpoint = [...events.slice(0, index)].reverse().find((event) => event.event.type === 'context.checkpoint')!.event
    const source = sourceCheckpoint.type === 'context.checkpoint' ? sourceCheckpoint.checkpoint.messages : []
    const stage = attempt.stages[ordinal]!
    audit.inputs.push({ scenario: attempt.scenario, stage: stage.stage, messages: input })
    for (const check of stage.grade.checks.filter((check) => !check.passed)) {
      const sourceVisible = contains(source, check.expected)
      const summaryInputVisible = contains(input, check.expected)
      const retainedVisible = contains(actual.messages as ChatMessage[], check.expected)
      const location = retainedVisible ? 'answer/precedence' : summaryInputVisible ? 'summary output or clipping'
        : sourceVisible ? 'pre-summary transcript selection' : 'already absent before this stage'
      audit.misses.push({ scenario: attempt.scenario, stage: stage.stage, field: check.field,
        sourceVisible, summaryInputVisible, retainedVisible, location })
    }
  }
}

/** 仅重建本地输入；输出同时保留推导依据，不能冒充线上抓包。 */
export async function auditSummaries(report: ContextReport): Promise<SummaryAudit> {
  const audit: SummaryAudit = { basis: 'offline deterministic reconstruction using the current context implementation; not a captured provider request',
    networkCalls: 0, inputs: [], misses: [] }
  for (const attempt of report.attempts.filter((attempt) => attempt.mode === 'summarize')) {
    await auditAttempt(attempt, report, audit)
  }
  return audit
}
