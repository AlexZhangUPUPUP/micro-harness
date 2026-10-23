/** 一次 Run 共享的预算；主 Agent、子 Agent 和摘要共同消耗同一个实例。 */
export interface RunBudgetOptions { maxCost?: number; maxTokens?: number }
export interface RunBudgetSnapshot { input: number; output: number; cost: number; maxTokens?: number; maxCost?: number; exceeded: boolean; reason?: 'tokens' | 'cost' }

export class RunBudget {
  readonly #maxCost?: number
  readonly #maxTokens?: number
  #input = 0
  #output = 0
  #cost = 0
  #reason?: 'tokens' | 'cost'

  constructor(options: RunBudgetOptions = {}) { this.#maxCost = options.maxCost; this.#maxTokens = options.maxTokens }

  /** 按真实 usage 结算；重复调用由调用方以事件粒度保证。 */
  consume(input: number, output: number, cost = 0): RunBudgetSnapshot {
    this.#input += Math.max(0, input)
    this.#output += Math.max(0, output)
    this.#cost += Math.max(0, cost)
    if (!this.#reason && this.#maxTokens !== undefined && this.#input + this.#output > this.#maxTokens) this.#reason = 'tokens'
    if (!this.#reason && this.#maxCost !== undefined && this.#cost > this.#maxCost) this.#reason = 'cost'
    return this.snapshot()
  }

  /** 查询预算是否已越界；越界后所有共享执行者都应停止。 */
  exceeded(): boolean { return this.#reason !== undefined }

  /** 返回不可变快照供事件和 UI 展示。 */
  snapshot(): RunBudgetSnapshot { return { input: this.#input, output: this.#output, cost: this.#cost, ...(this.#maxTokens !== undefined ? { maxTokens: this.#maxTokens } : {}), ...(this.#maxCost !== undefined ? { maxCost: this.#maxCost } : {}), exceeded: this.exceeded(), ...(this.#reason ? { reason: this.#reason } : {}) } }
}
