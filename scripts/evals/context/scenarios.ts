import { createHash } from 'node:crypto'
import type { ChatMessage } from '@micro-harness/core'
import type { ContextScenario, FieldKind, ScenarioStage } from './types.ts'

/** 只用于恢复字节一致性，不要求模型解释图像内容。 */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0kAAAAASUVORK5CYII='

/** 将种子和语义位置映射为不可从字段名猜测的稳定事实。 */
function nonce(seed: string, label: string): string {
  return createHash('sha256').update(`${seed}:${label}`).digest('hex').slice(0, 12)
}

/** 为日志生成完整的四工具批次，每条输出均低于默认截断阈值。 */
function noiseBatch(seed: string, label: string): ChatMessage[] {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    id: `call_${nonce(seed, `${label}:${index}`)}`, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: `trace_${label}_${index}.log` }) },
  }))
  const assistant: ChatMessage = { role: 'assistant', content: null, tool_calls: calls }
  // 日志只含无关诊断信息，不加入 STATE 或可被误识别为答案的字段。
  const results: ChatMessage[] = calls.map((call, index) => ({
    role: 'tool', tool_call_id: call.id, name: 'read_file',
    content: (`Trace ${nonce(seed, `${label}:text:${index}`)}. `
      + 'Routine diagnostic sample: cache warmed; local probe returned stable bytes; no task state was changed. '.repeat(10)).slice(0, 720),
  }))
  return [assistant, ...results]
}

/** 将真实历史事实与自然语言说明同时呈现，mock 只从可见 STATE 读取。 */
function factMessage(explanation: string, facts: Record<string, string>, tool?: string): ChatMessage[] {
  const content = `${explanation}\n${Object.entries(facts).map(([key, value]) => `STATE ${key}=${value}`).join('\n')}`
  if (!tool) return [{ role: 'user', content }]
  // 已完成动作只作为历史结果注入，不能要求模型再次调用来读取答案。
  return [{ role: 'assistant', content: null, tool_calls: [{ id: `fact_${tool}`, type: 'function',
    function: { name: tool, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `fact_${tool}`, name: tool, content }]
}

/** 构造每阶段固定压力，事实放在噪声中段，最终问题只包含字段名。 */
function stage(
  seed: string, label: string, expected: Record<string, string>, kind: FieldKind,
  intro: ChatMessage[] = [], facts: ChatMessage[] = [], restart = false,
): ScenarioStage {
  const history = [...intro, ...noiseBatch(seed, `${label}_0`), ...facts]
  // 后续日志使中段事实确实面临压缩，而非仅靠模型选择性读工具制造压力。
  for (let index = 1; index < 4; index++) history.push(...noiseBatch(seed, `${label}_${index}`))
  return { history, expected: { ...expected },
    fieldKinds: Object.fromEntries(Object.keys(expected).map((key) => [key, kind])),
    prompt: `请仅输出 JSON 对象，字段为：${Object.keys(expected).join(', ')}。依据历史填写当前有效值；未知值写 unknown。不要重新执行已经完成的操作。\nFIELDS: ${JSON.stringify(Object.keys(expected))}`,
    ...(restart ? { restart: true } : {}) }
}

/** 首条用户约束必须跨多轮压力持续生效，中段约束不能在后续问题重新泄漏。 */
function constraints(seed: string): ContextScenario {
  const facts = { project_code: `project_${nonce(seed, 'constraints:project')}`,
    api_contract: `contract_${nonce(seed, 'constraints:contract')}`, no_push: 'true' }
  const expected = { ...facts, target_branch: `branch_${nonce(seed, 'constraints:branch')}` }
  const intro = factMessage('项目代号与接口契约固定不变；未经另行授权禁止推送。请保留这些约束。', facts)
  const branch = factMessage('追加工作约束：所有后续工作只能使用以下目标分支。', { target_branch: expected.target_branch })
  return { id: 'constraints', title: '首轮约束和中途追加约束', seed, forbiddenTools: ['publish'], stages: [
    stage(seed, 'constraints_0', expected, 'constraint', intro, branch),
    stage(seed, 'constraints_1', expected, 'constraint'),
    stage(seed, 'constraints_2', expected, 'constraint'),
  ] }
}

/** 第二阶段明确废弃旧值，评分只接受更新后的权威事实。 */
function correction(seed: string): ContextScenario {
  const old = { active_route: `route_${nonce(seed, 'correction:old')}`,
    owner_tag: `owner_${nonce(seed, 'correction:owner')}` }
  const updated = { ...old, active_route: `route_${nonce(seed, 'correction:new')}` }
  const intro = factMessage('记录初始路由和负责人标签；后续明确纠正应覆盖旧配置。', old)
  const update = factMessage('纠正：先前路由已经废弃，当前只允许使用新路由，负责人标签保持原值。',
    { active_route: updated.active_route })
  return { id: 'correction', title: '中途纠正覆盖早期旧值', seed, forbiddenTools: [], stages: [
    stage(seed, 'correction_0', old, 'correction', intro),
    stage(seed, 'correction_1', updated, 'correction', [], update),
    stage(seed, 'correction_2', updated, 'correction'),
  ] }
}

/** 已完成测试与下一步在工具历史中出现，重复执行属于独立失败条件。 */
function progress(seed: string): ContextScenario {
  const facts = { completed_step: `tests_${nonce(seed, 'progress:done')}`,
    next_step: `review_${nonce(seed, 'progress:next')}`, validation: `pass_${nonce(seed, 'progress:validation')}` }
  const updated = { ...facts, next_step: `package_${nonce(seed, 'progress:updated')}` }
  const intro = factMessage('测试日志中的 DONE 表示已经完成，不得再次运行 run_completed_tests；禁止推送。', { no_push: 'true' })
  const done = factMessage('DONE：指定测试已完成。validation 为通过凭据，next_step 为唯一待办。', facts, 'run_completed_tests')
  const update = factMessage('评审已完成，待办更新为新的 next_step；已有测试结果仍然有效。', { next_step: updated.next_step })
  return { id: 'progress', title: '完成进度、验证凭据与不重复执行', seed,
    forbiddenTools: ['run_completed_tests', 'publish'], stages: [
      stage(seed, 'progress_0', facts, 'progress', intro, done),
      stage(seed, 'progress_1', updated, 'progress', [], update),
      stage(seed, 'progress_2', updated, 'progress'),
    ] }
}

/** 通过真实 checkpoint 重启恢复历史，图片只用于检查多模态字节是否保持。 */
function restart(seed: string): ContextScenario {
  const initial = { recovery_key: `recover_${nonce(seed, 'restart:key')}` }
  const facts = { ...initial, artifact_id: `artifact_${nonce(seed, 'restart:artifact')}`,
    pending_step: `verify_${nonce(seed, 'restart:pending')}` }
  const updated = { ...facts, pending_step: `archive_${nonce(seed, 'restart:updated')}` }
  const intro = factMessage('稍后将重启进程。保留恢复凭据以及随后工具日志中的产物标识与待办。', initial)
  // 图片不包含答案，不参与视觉评分，仅验证序列化与恢复一致性。
  intro[0] = { role: 'user', content: [
    { type: 'text', text: `${String(intro[0]!.content)}\n附加无关占位图片，无需解释。` },
    { type: 'image_url', image_url: { url: PIXEL } },
  ] }
  const observation = factMessage('产物已保存，请记录标识与恢复后的下一步。',
    { artifact_id: facts.artifact_id, pending_step: facts.pending_step }, 'read_file')
  const update = factMessage('恢复验证完成，下一步改为归档。', { pending_step: updated.pending_step })
  return { id: 'restart', title: '压缩后磁盘重启恢复', seed, forbiddenTools: ['publish'], stages: [
    stage(seed, 'restart_0', facts, 'recovery', intro, observation),
    stage(seed, 'restart_1', facts, 'recovery', [], [], true),
    stage(seed, 'restart_2', updated, 'recovery', [], update),
  ] }
}

/** 同一 seed 只构造一套 fixture，供完整历史和两种压缩模式共享。 */
export function buildScenarios(seed: string): ContextScenario[] {
  return [constraints(seed), correction(seed), progress(seed), restart(seed)]
}
