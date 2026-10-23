import type { TaskSnapshot } from '../lib/api.ts'

const statusLabels: Record<TaskSnapshot['status'], string> = {
  queued: '排队中', running: '执行中', waiting_approval: '等待批准', awaiting_verification: '等待验证', interrupted: '已中断', completed: '已完成', failed: '失败', cancelled: '已取消',
}

/** 展示目标、步骤、约束和验证结果；状态颜色同时配合文字，满足无障碍辨识。 */
export function TaskPanel({ task, onComplete }: { task: TaskSnapshot; onComplete?: () => void }) {
  return (
    <section className="h-full overflow-y-auto p-3 text-xs" aria-label="任务状态">
      <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-foreground">任务状态</h2><span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">{statusLabels[task.status]}</span></div>
      <div className="mb-4 rounded-lg border border-border bg-muted/20 p-3"><div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">目标</div><p className="whitespace-pre-wrap leading-5 text-foreground">{task.goal || '尚未设置任务目标'}</p></div>
      <TaskList title="步骤" empty="暂无步骤" items={task.steps.map((step) => `${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '•' : '○'} ${step.title}`)} />
      <TaskList title="约束" empty="暂无约束" items={task.constraints} />
      <TaskList title="验证" empty="暂无验证记录" items={task.verifications.map((item) => `${item.status === 'passed' ? '通过' : item.status === 'failed' ? '失败' : item.status === 'stale' ? '过期' : '未执行'} · ${item.label}`)} />
      <TaskList title="阻塞" empty="暂无阻塞项" items={task.blockers} />
      {task.status === 'awaiting_verification' && task.verifications.length > 0 && task.verifications.every((item) => item.status === 'passed') && onComplete && <button type="button" className="mt-1 min-h-9 w-full rounded-md border border-teal/50 px-3 py-2 text-teal hover:bg-teal/10" onClick={onComplete}>确认任务完成</button>}
      <div className="mt-4 text-[10px] text-muted-foreground">修订版本 {task.revision}</div>
    </section>
  )
}

/** 统一渲染任务条目和空态。 */
function TaskList({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return <div className="mb-4"><h3 className="mb-1.5 font-medium text-muted-foreground">{title}</h3>{items.length ? <ul className="space-y-1.5 text-foreground">{items.map((item, index) => <li key={`${item}-${index}`} className="rounded-md border border-border/70 px-2 py-1.5 leading-4">{item}</li>)}</ul> : <p className="text-muted-foreground">{empty}</p>}</div>
}
