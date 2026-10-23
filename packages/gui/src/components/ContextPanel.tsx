import { useEffect, useMemo, useState } from 'react'
import { api, type ContextEvent } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtTime, fmtTokens } from '../lib/format.ts'

type ContextPayload = {
  type: string; snapshotId?: string; compactionId?: string; trigger?: string
  tokens?: number; budget?: number; messages?: unknown[]; sources?: Record<string, number>
  reason?: string; strategy?: string; beforeTokens?: number; afterTokens?: number
  dropped?: number; summarized?: number; beforeMessages?: unknown[]; afterMessages?: unknown[]; fallback?: boolean
}
type Message = { role: string; content: string }

/** 把模型消息转换为可读的角色和文本。 */
function normalizeMessage(value: unknown): Message {
  if (!value || typeof value !== 'object') return { role: 'unknown', content: String(value ?? '') }
  const item = value as Record<string, unknown>
  const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? item)
  return { role: String(item.role ?? 'unknown'), content }
}

/** 统计各角色消息数量，用于解释上下文构成。 */
function roleCounts(messages: unknown[]): Record<string, number> {
  return messages.map(normalizeMessage).reduce<Record<string, number>>((result, item) => {
    result[item.role] = (result[item.role] ?? 0) + 1
    return result
  }, {})
}

/** 将内部字段翻译成用户能理解的压缩原因和策略。 */
function explain(value: string | undefined, kind: 'reason' | 'strategy'): string {
  const labels: Record<string, string> = kind === 'reason'
    ? { context_budget: '达到上下文预算', manual: '手动触发', overflow: '上下文超限' }
    : { 'keep-head+tail': '保留开头和结尾', 'keep-head+steps': '保留开头并抽样', summarize: '摘要旧消息', tail: '保留最近消息', steps: '按步裁剪' }
  return labels[value ?? ''] ?? value ?? '未知'
}

/** 展示单个 session 的实时上下文快照、压缩节点和前后窗口。 */
export function ContextPanel({ events, sessionId }: { events: ContextEvent[]; sessionId: string | null }) {
  const { t } = useT()
  const [selected, setSelected] = useState(0)
  const [following, setFollowing] = useState(true)
  const latest = events.length - 1
  useEffect(() => { if (following) setSelected(Math.max(0, latest)) }, [events.length, following, latest])
  const item = events[selected]
  const payload = item?.event as ContextPayload | undefined
  const latestSnapshot = useMemo(() => [...events].reverse().find((entry) => entry.event.type === 'context.snapshot'), [events])
  const summary = latestSnapshot?.event as ContextPayload | undefined

  return <div className="flex h-full flex-col">
    <ContextHeader count={events.length} sessionId={sessionId} following={following} onFollow={() => setFollowing((value) => !value)} />
    {summary && <ContextSummary payload={summary} />}
    {events.length === 0 ? <div className="px-3 py-6 text-center text-muted-foreground">{t('context.empty')}</div> : <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {events.map((entry, index) => <button key={`${entry.agentId}:${entry.seq}`} onClick={() => { setFollowing(false); setSelected(index) }} className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] ${index === selected ? 'border-teal/50 bg-teal/10 text-teal' : 'border-border text-muted-foreground'}`}>{entry.event.type === 'context.compaction' ? t('context.compaction') : t('context.snapshot')} {index + 1}</button>)}
      </div>
      {item && payload && <ContextDetail payload={payload} timestamp={item.t} />}
    </div>}
  </div>
}

/** 固定显示导出和跟随控制，避免上下文事件增长时按钮消失。 */
function ContextHeader({ count, sessionId, following, onFollow }: { count: number; sessionId: string | null; following: boolean; onFollow: () => void }) {
  const { t } = useT()
  return <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-[11px]"><span className="font-mono text-muted-foreground">{t('context.title', { n: count })}</span><div className="flex items-center gap-1">{sessionId && <a className="rounded border border-border px-1.5 py-0.5 text-[10px] text-teal hover:bg-teal/10" href={api.contextExportUrl(sessionId)} download>{t('context.export')}</a>}<button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={onFollow}>{following ? t('context.pause') : t('context.follow')}</button></div></div>
}

/** 显示最新快照的预算进度和消息角色分布。 */
function ContextSummary({ payload }: { payload: ContextPayload }) {
  const { t } = useT()
  const ratio = payload.budget ? Math.min(100, Math.round(((payload.tokens ?? 0) / payload.budget) * 100)) : 0
  const counts = roleCounts(payload.messages ?? [])
  return <div className="space-y-1.5 border-b border-border px-3 py-2 text-[10px]"><div className="flex justify-between text-muted-foreground"><span>{t('context.current')}</span><span>{fmtTokens(payload.tokens ?? 0)} / {fmtTokens(payload.budget ?? 0)} · {ratio}%</span></div><div className="h-1 overflow-hidden rounded bg-muted"><div className={`h-full ${ratio >= 80 ? 'bg-destructive' : 'bg-teal'}`} style={{ width: `${ratio}%` }} /></div><div className="flex flex-wrap gap-1 text-muted-foreground">{Object.entries(counts).map(([role, count]) => <span key={role} className="rounded bg-muted px-1.5 py-0.5">{role} {count}</span>)}</div></div>
}

/** 展示选中的快照或压缩记录，默认使用结构化摘要而非原始 JSON。 */
function ContextDetail({ payload, timestamp }: { payload: ContextPayload; timestamp: number }) {
  const isCompaction = payload.type === 'context.compaction'
  const messages = isCompaction ? payload.afterMessages ?? [] : payload.messages ?? []
  const before = payload.beforeMessages ?? []
  const reduction = payload.beforeTokens ? Math.round((1 - (payload.afterTokens ?? 0) / payload.beforeTokens) * 100) : 0
  return <div className="space-y-2 p-2 text-[10px]"><div className="rounded-lg border border-border bg-card/70 p-2 text-muted-foreground"><div className="flex items-center justify-between"><b className="text-foreground">{isCompaction ? '上下文压缩' : '发送给模型的上下文'}</b><span>{fmtTime(timestamp)}</span></div>{isCompaction ? <><div className="mt-1 text-foreground">{explain(payload.reason, 'reason')} · {explain(payload.strategy, 'strategy')}</div><div className="mt-1">{fmtTokens(payload.beforeTokens ?? 0)} → {fmtTokens(payload.afterTokens ?? 0)}（减少 {Math.max(0, reduction)}%） · 删除 {payload.dropped ?? 0} 条 · 摘要 {payload.summarized ?? 0} 条{payload.fallback ? ' · 使用降级策略' : ''}</div></> : <div className="mt-1">触发：{payload.trigger ?? '模型请求'} · 共 {messages.length} 条消息 · 约 {fmtTokens(payload.tokens ?? 0)} tokens</div>}</div>{isCompaction ? <Comparison before={before} after={messages} /> : <MessageList messages={messages} />}</div>
}

/** 用数量和可展开消息解释压缩前后的变化。 */
function Comparison({ before, after }: { before: unknown[]; after: unknown[] }) {
  return <div className="space-y-2"><div className="grid grid-cols-2 gap-2"><StatCard title="压缩前" counts={roleCounts(before)} total={before.length} tone="destructive" /><StatCard title="压缩后" counts={roleCounts(after)} total={after.length} tone="teal" /></div><details className="rounded-lg border border-border p-2"><summary className="cursor-pointer text-muted-foreground">查看压缩后消息（{after.length} 条）</summary><MessageList messages={after} /></details><details className="rounded-lg border border-border p-2"><summary className="cursor-pointer text-muted-foreground">查看压缩前消息（{before.length} 条）</summary><MessageList messages={before} /></details></div>
}

/** 显示角色统计卡片，帮助定位是哪类消息占用预算。 */
function StatCard({ title, counts, total, tone }: { title: string; counts: Record<string, number>; total: number; tone: 'teal' | 'destructive' }) {
  return <div className={`rounded-lg border p-2 ${tone === 'teal' ? 'border-teal/30 bg-teal/5' : 'border-destructive/30 bg-destructive/5'}`}><div className="font-medium text-foreground">{title} · {total} 条</div><div className="mt-1 flex flex-wrap gap-1 text-muted-foreground">{Object.entries(counts).map(([role, count]) => <span key={role}>{role} {count}</span>)}</div></div>
}

/** 以角色标签和摘要显示消息，长内容可单独展开。 */
function MessageList({ messages }: { messages: unknown[] }) {
  return <div className="mt-2 space-y-1.5">{messages.map((value, index) => { const message = normalizeMessage(value); return <details key={`${message.role}-${index}`} className="rounded border border-border bg-muted/20 p-1.5"><summary className="cursor-pointer list-none"><span className="mr-1 rounded bg-muted px-1 py-0.5 font-medium text-foreground">{message.role}</span><span className="text-muted-foreground">{preview(message.content)}</span></summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border pt-1 leading-relaxed text-foreground/90">{message.content}</pre></details> })}</div>
}

/** 折叠长消息，保留足够信息判断上下文内容。 */
function preview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact || '（空消息）'
}
