#!/usr/bin/env bun
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { openaiProvider } from '../../../packages/core/src/provider.ts'
import { readConfig } from './config.ts'
import { requestVisibleProvider } from './mock.ts'
import { EvaluationBudget } from './provider.ts'
import { buildScenarios } from './scenarios.ts'
import { runAttempt } from './runner.ts'
import { renderMarkdown, summarizeModes } from './report.ts'
import { auditSummaries } from './audit.ts'
import type { ContextMode, ContextReport } from './types.ts'

const HELP = `Context evaluation: --mock --runs=1 --seed=context-v1
  --budget=3200 --baseline-budget=32000 --output-tokens=256
  --scenarios=constraints,correction,progress,restart --out-dir=PATH
  --timeout=60000 --max-requests=100 --max-cost=0.25
Real mode uses MICRO_* / OPENAI_* or DEEPSEEK_API_KEY; never prints credentials.
Mock results validate mechanisms only. Real runs are small-sample smoke evidence.`

/** 每完成一次比较就保存报告，即使后续服务失败仍保留证据。 */
function save(report: ContextReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(path.join(outDir, 'results.md'), renderMarkdown(report))
}

/** 同一运行编号三组共用种子，轮换执行顺序减少固定顺序偏差。 */
async function main(): Promise<void> {
  if (process.argv.includes('--help')) { console.log(HELP); return }
  const config = readConfig(process.argv.slice(2))
  const report: ContextReport = { version: 1, assessment: config.report.backend === 'mock' ? 'mechanism-only' : 'real-model-smoke',
    config: config.report, attempts: [] }
  const provider = config.report.backend === 'mock' ? requestVisibleProvider()
    : openaiProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, temperature: 0 })
  const budget = new EvaluationBudget(config.report.maxRequests, config.report.maxCost, config.pricing)
  for (let run = 1; run <= config.report.runs; run++) {
    const scenarios = buildScenarios(`${config.report.seed}:${run}`)
    const selected = config.scenarios ? scenarios.filter((scenario) => config.scenarios!.includes(scenario.id)) : scenarios
    if (!selected.length || config.scenarios?.some((id) => !scenarios.some((scenario) => scenario.id === id))) {
      throw new Error('Unknown or empty scenario selection')
    }
    const modes: ContextMode[] = ['full-history', 'drop-middle', 'summarize']
    const ordered = [...modes.slice((run - 1) % 3), ...modes.slice(0, (run - 1) % 3)]
    for (const scenario of selected) for (const mode of ordered) {
      console.log(`running ${config.report.backend} ${scenario.id}/${mode} run ${run}`)
      const result = await runAttempt(config, scenario, mode, run, provider, budget)
      report.attempts.push(result)
      save(report, config.outDir)
      console.log(`  ${result.status}; calls=${result.metrics.requests}; trims=${result.stages.flatMap((stage) => stage.trimStrategies).length}`)
    }
  }
  // 事后还原摘要输入以定位信息损失，过程不额外访问模型服务。
  writeFileSync(path.join(config.outDir, 'summary-input-audit.json'), JSON.stringify(await auditSummaries(report), null, 2) + '\n')
  console.table(summarizeModes(report.attempts).map((row) => ({ mode: row.mode, pass: row.pass, fail: row.fail,
    error: row.error, invalid: row.invalid, calls: row.metrics.requests, estimatedCost: row.metrics.estimatedCost })))
  console.log(`Results: ${path.join(config.outDir, 'results.md')}`)
  // 负对照的记忆失败也保留非零退出码，不能误报整套质量检查通过。
  if (report.attempts.some((attempt) => attempt.status !== 'pass')) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(String((error as Error).message))
  process.exitCode = 2
})
