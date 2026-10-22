import type { Grade, ScenarioStage } from './types.ts'

/** 仅接受完整 JSON 对象，防止答案夹在说明、代码块或引用中被误判为成功。 */
function parseAnswer(answer: string): { fields: Record<string, unknown>; error?: string } {
  try {
    const parsed: unknown = JSON.parse(answer)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { fields: {}, error: 'answer must be a JSON object' }
    }
    return { fields: parsed as Record<string, unknown> }
  } catch {
    // 解析失败是明确失败结果，不通过正则从任意文本中捞取期望值。
    return { fields: {}, error: 'answer is not valid JSON' }
  }
}

/** 按字段逐项比较并独立检查重复操作，评分不参与 mock 的回答构造。 */
export function gradeAnswer(answer: string, stage: ScenarioStage, calls: string[], forbiddenTools: string[]): Grade {
  const parsed = parseAnswer(answer)
  const checks = Object.entries(stage.expected).map(([field, expected]) => {
    const actual = typeof parsed.fields[field] === 'string' ? parsed.fields[field] as string : null
    return { field, expected, actual, passed: actual === expected, category: stage.fieldKinds[field]! }
  })
  // 只统计本阶段真实发生的工具调用，历史注入记录不代表模型再次执行。
  const forbidden = new Set(forbiddenTools)
  const repeatedTools = [...new Set(calls.filter((call) => forbidden.has(call)))]
  return { passed: !parsed.error && checks.every((check) => check.passed) && repeatedTools.length === 0,
    checks, repeatedTools, ...(parsed.error ? { parseError: parsed.error } : {}) }
}
