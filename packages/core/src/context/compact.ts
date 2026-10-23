import type { ChatMessage } from '../model.ts'
import { estimateTokens } from './budget.ts'
import { COMPACT_RECAP_PREFIX, type CompactOptions, type Summarizer, type TrimResult } from './types.ts'

/** 将用户轮次或助手步骤分组，工具结果始终随所属助手步骤一起保留。 */
function groupMessages(messages: ChatMessage[], boundary: 'user' | 'assistant'): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  for (const message of messages) {
    if (message.role === boundary || !groups.length) groups.push([message])
    else groups[groups.length - 1]!.push(message)
  }
  return groups
}

/** 压缩计划保留原消息引用，使未移除前缀继续支持提供方缓存。 */
interface CompactPlan { messages: ChatMessage[]; dropped: ChatMessage[]; strategy: TrimResult['strategy'] }

/** 从中间移除旧轮次；首轮过大时只保留首条用户约束，再裁最新轮旧步骤。 */
function makePlan(messages: ChatMessage[], options: CompactOptions): CompactPlan {
  const system = messages.filter((message) => message.role === 'system')
  const rest = messages.filter((message) => message.role !== 'system')
  const units = groupMessages(rest, 'user')
  const keepHead = (options.keepHead ?? true) && units.length > 1
  let head = keepHead ? units[0]! : []
  const tail = units.slice(keepHead ? 1 : 0)
  let strategy: TrimResult['strategy'] = keepHead ? 'keep-head+tail' : 'tail'
  const exceeds = () => estimateTokens([...system, ...head, ...tail.flat()]) > options.maxTokens
  // 优先丢弃完整旧轮次，保留最新用户任务。
  while (tail.length > 1 && exceeds()) tail.shift()
  if (exceeds() && head.length > 1) head = head.slice(0, 1)
  // 单轮可能含大量工具调用，按完整助手步骤裁剪，保留最新一步。
  if (exceeds() && tail.length) {
    const steps = groupMessages(tail[tail.length - 1]!, 'assistant')
    const lead = steps.shift() ?? []
    let removed = false
    while (steps.length > 1 && exceeds()) {
      steps.shift()
      tail[tail.length - 1] = [...lead, ...steps.flat()]
      removed = true
    }
    if (removed) strategy = keepHead ? 'keep-head+steps' : 'steps'
  }
  const kept = [...system, ...head, ...tail.flat()]
  const keptSet = new Set(kept)
  return { messages: kept, dropped: messages.filter((message) => !keptSet.has(message)), strategy }
}

/** 将计划转成结果，显式报告不可裁内容超限，禁止伪装为预算已满足。 */
function planResult(original: ChatMessage[], plan: CompactPlan, maxTokens: number): TrimResult {
  const tokens = estimateTokens(plan.messages)
  const changed = original.length !== plan.messages.length
    || original.some((message, index) => message !== plan.messages[index])
  return { messages: changed ? plan.messages : original, dropped: plan.dropped.length, tokens,
    strategy: plan.strategy, changed, ...(tokens > maxTokens ? { overflow: true } : {}) }
}

/** 确定性压缩只移除历史，不改写用户、系统或保留下来的工具消息。 */
export function compactMessages(messages: ChatMessage[], options: CompactOptions): TrimResult {
  options.signal?.throwIfAborted()
  const tokens = estimateTokens(messages)
  if (tokens <= options.maxTokens) return { messages, dropped: 0, tokens, strategy: 'none', changed: false }
  return planResult(messages, makePlan(messages, options), options.maxTokens)
}

/** 为摘要添加统一前缀并按 UTF-8 估计预算截短，避免摘要重新挤爆窗口。 */
function boundedRecap(text: string, maxTokens: number): ChatMessage | undefined {
  const prefix = `${COMPACT_RECAP_PREFIX}\n`
  const content = text.startsWith(COMPACT_RECAP_PREFIX) ? text : prefix + text
  const cost = (value: string) => estimateTokens([{ role: 'user', content: value }])
  if (cost(prefix) > maxTokens) return undefined
  let low = prefix.length
  let high = content.length
  // 二分查找可容纳的字符边界，不对保留的原始消息做任何截断。
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (cost(content.slice(0, middle)) <= maxTokens) low = middle
    else high = middle - 1
  }
  return { role: 'user', content: content.slice(0, low) }
}

/** 在第一条被删除消息的位置放入回顾，保持首轮约束和后续消息的原始顺序。 */
function insertRecap(original: ChatMessage[], plan: CompactPlan, recap: ChatMessage): ChatMessage[] {
  const removed = new Set(plan.dropped)
  const result: ChatMessage[] = []
  let inserted = false
  for (const message of original) {
    if (!removed.has(message)) result.push(message)
    else if (!inserted) { result.push(recap); inserted = true }
  }
  return result
}

/** 摘要先预留有界预算，失败回退确定性计划，父请求取消则原样抛出。 */
export async function compactMessagesAsync(
  messages: ChatMessage[], options: CompactOptions & { summarizer?: Summarizer },
): Promise<TrimResult> {
  const base = compactMessages(messages, options)
  if (!options.summarizer || !base.dropped || base.overflow) return base
  const reserve = Math.max(1, Math.min(300, Math.floor(options.maxTokens * 0.15)))
  const plan = makePlan(messages, { ...options, maxTokens: options.maxTokens - reserve })
  if (estimateTokens(plan.messages) > options.maxTokens - reserve) return { ...base, fallback: true }
  try {
    // 摘要调用只得到预留输出预算，并继承父请求的取消信号。
    const summary = await options.summarizer(plan.dropped, { signal: options.signal, maxTokens: reserve })
    options.signal?.throwIfAborted()
    const recap = boundedRecap(summary, reserve)
    if (!recap) return { ...base, fallback: true }
    const compacted = insertRecap(messages, plan, recap)
    const tokens = estimateTokens(compacted)
    if (tokens > options.maxTokens) return { ...base, fallback: true }
    return { messages: compacted, dropped: plan.dropped.length - 1, tokens,
      strategy: 'summarize', summarized: plan.dropped.length, changed: true }
  } catch {
    // 摘要提供方失败允许降级，用户取消必须终止整个请求。
    options.signal?.throwIfAborted()
    return { ...base, fallback: true }
  }
}

/** 保留旧入口，默认启用首条用户约束保护。 */
export function trimMessages(messages: ChatMessage[], maxTokens: number): TrimResult {
  return compactMessages(messages, { maxTokens })
}
