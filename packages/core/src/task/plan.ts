/** 结构化任务状态；它描述目标和验证进度，不从助手文本推断完成。 */
export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'
export type VerificationStatus = 'not_run' | 'passed' | 'failed' | 'stale'

export interface TaskStep {
  id: string
  title: string
  status: TaskStepStatus
}

export interface TaskVerification {
  id: string
  label: string
  status: VerificationStatus
  details?: string
}

export interface TaskSnapshot {
  version: 1
  revision: number
  goal: string
  status: TaskStatus
  constraints: string[]
  steps: TaskStep[]
  verifications: TaskVerification[]
  blockers: string[]
  updatedAt: number
}

export interface TaskUpdate {
  expectedRevision?: number
  goal?: string
  status?: TaskStatus
  constraints?: string[]
  steps?: TaskStep[]
  verifications?: TaskVerification[]
  blockers?: string[]
}

const statuses = new Set<TaskStatus>(['queued', 'running', 'waiting_approval', 'interrupted', 'completed', 'failed', 'cancelled'])
const stepStatuses = new Set<TaskStepStatus>(['pending', 'in_progress', 'completed', 'skipped'])
const verificationStatuses = new Set<VerificationStatus>(['not_run', 'passed', 'failed', 'stale'])
const MAX_TEXT = 2000
const MAX_ITEMS = 32

/** 创建空任务，目标由显式任务更新提供。 */
export function createTaskSnapshot(now = Date.now()): TaskSnapshot {
  return { version: 1, revision: 0, goal: '', status: 'queued', constraints: [], steps: [], verifications: [], blockers: [], updatedAt: now }
}

/** 校验外部任务状态，防止非法或超大数据进入事件流。 */
export function validateTaskSnapshot(input: unknown): input is TaskSnapshot {
  if (!input || typeof input !== 'object') return false
  const state = input as TaskSnapshot
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.goal !== 'string' || state.goal.length > MAX_TEXT || !statuses.has(state.status)
    || !Array.isArray(state.constraints) || state.constraints.length > MAX_ITEMS
    || !Array.isArray(state.steps) || state.steps.length > MAX_ITEMS
    || !Array.isArray(state.verifications) || state.verifications.length > MAX_ITEMS
    || !Array.isArray(state.blockers) || state.blockers.length > MAX_ITEMS
    || !Number.isSafeInteger(state.updatedAt)) return false
  if ([...state.constraints, ...state.blockers].some((x) => typeof x !== 'string' || x.length > MAX_TEXT)) return false
  if (state.steps.some((step) => !step || typeof step.id !== 'string' || step.id.length > 128 || typeof step.title !== 'string' || step.title.length > MAX_TEXT || !stepStatuses.has(step.status))) return false
  return !state.verifications.some((item) => !item || typeof item.id !== 'string' || item.id.length > 128 || typeof item.label !== 'string' || item.label.length > MAX_TEXT || !verificationStatuses.has(item.status) || (item.details !== undefined && (typeof item.details !== 'string' || item.details.length > MAX_TEXT)))
}

/** 应用显式更新；版本冲突直接拒绝，避免并发编辑覆盖彼此。 */
export function applyTaskUpdate(snapshot: TaskSnapshot, update: TaskUpdate, now = Date.now()): TaskSnapshot {
  if (update.expectedRevision !== undefined && update.expectedRevision !== snapshot.revision) throw new Error('task revision conflict')
  const next: TaskSnapshot = { ...snapshot, revision: snapshot.revision + 1, updatedAt: now }
  if (update.goal !== undefined) next.goal = update.goal.trim()
  if (update.status !== undefined) next.status = update.status
  if (update.constraints !== undefined) next.constraints = update.constraints.map((item) => item.trim()).filter(Boolean).slice(0, MAX_ITEMS)
  if (update.steps !== undefined) next.steps = update.steps.slice(0, MAX_ITEMS).map((step) => ({ ...step, id: step.id.trim(), title: step.title.trim() }))
  if (update.verifications !== undefined) next.verifications = update.verifications.slice(0, MAX_ITEMS).map((item) => ({ ...item, id: item.id.trim(), label: item.label.trim() }))
  if (update.blockers !== undefined) next.blockers = update.blockers.map((item) => item.trim()).filter(Boolean).slice(0, MAX_ITEMS)
  if (!validateTaskSnapshot(next)) throw new Error('invalid task update')
  return next
}

/** 从事件流重建任务状态，支持会话恢复、SSE 回放和 fork。 */
export function deriveTaskState(events: Array<{ event: { type: string; snapshot?: unknown } }>): TaskSnapshot {
  let state = createTaskSnapshot()
  for (const item of events) {
    if (item.event.type !== 'task.update' || !validateTaskSnapshot(item.event.snapshot)) continue
    if (item.event.snapshot.revision > state.revision) state = structuredClone(item.event.snapshot)
  }
  return state
}
