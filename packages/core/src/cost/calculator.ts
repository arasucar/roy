import { PRICING_BY_ID, MODEL_PRICING, PRICING_AS_OF } from './pricing.js'
import type { ModelInfo } from '../types/provider.js'

export type OnMissingModel = 'throw' | 'warn' | 'zero'

export interface CostCalculatorConfig {
  /**
   * Override pricing for specific models.
   * Useful for enterprise agreements, reserved pricing, or new models
   * not yet in Roy's built-in table.
   *
   * @example
   * ```ts
   * pricingOverrides: {
   *   'my-custom-model': {
   *     inputPricePerMillion: 2.0,
   *     outputPricePerMillion: 8.0,
   *   }
   * }
   * ```
   */
  pricingOverrides?: Record<
    string,
    Partial<
      Pick<
        ModelInfo,
        | 'inputPricePerMillion'
        | 'outputPricePerMillion'
        | 'cacheWritePricePerMillion'
        | 'cacheReadPricePerMillion'
      >
    >
  >
  /**
   * What to do when a model isn't in the pricing table and has no override:
   *   - 'warn' (default): log a warning once per model, return zero cost.
   *   - 'throw': throw an error (good for prod billing).
   *   - 'zero': silently return zero cost (good for tests / local).
   */
  onMissingModel?: OnMissingModel
  /** Replace `console` (useful for tests). */
  logger?: { warn: (...args: unknown[]) => void }
}

export interface TurnCost {
  modelId: string
  promptTokens: number
  completionTokens: number
  /** Anthropic-only: tokens written to prompt cache this turn. */
  cacheCreationInputTokens: number
  /** Anthropic-only: tokens read from prompt cache this turn. */
  cacheReadInputTokens: number
  /** Estimated cost in USD for this single turn */
  estimatedCostUsd: number
  /** Whether pricing was exact (model found) or zero (model unknown) */
  pricingSource: 'table' | 'override' | 'unknown'
}

export interface SessionCostSummary {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalCostUsd: number
  costByModel: Record<string, { tokens: number; costUsd: number }>
}

export interface CalculateInput {
  promptTokens: number
  completionTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export class CostCalculator {
  private overrides: CostCalculatorConfig['pricingOverrides']
  private readonly onMissing: OnMissingModel
  private readonly logger: { warn: (...args: unknown[]) => void }
  private readonly warnedFor = new Set<string>()

  constructor(config: CostCalculatorConfig = {}) {
    this.overrides = config.pricingOverrides
    this.onMissing = config.onMissingModel ?? 'warn'
    this.logger = config.logger ?? console
  }

  /**
   * Date the bundled pricing table was last reviewed. Useful for surfacing in
   * UI ("pricing as of 2026-05-26") and for staleness checks.
   */
  get pricingAsOf(): string {
    return PRICING_AS_OF
  }

  /**
   * Calculate cost for a single LLM turn.
   *
   * Supports two call shapes for backwards compatibility:
   *   calculator.calculate('model-id', 100, 50)
   *   calculator.calculate('model-id', { promptTokens: 100, completionTokens: 50,
   *                                      cacheReadInputTokens: 1500 })
   */
  calculate(modelId: string, promptTokens: number, completionTokens: number): TurnCost
  calculate(modelId: string, usage: CalculateInput): TurnCost
  calculate(modelId: string, arg2: number | CalculateInput, arg3?: number): TurnCost {
    const usage: CalculateInput =
      typeof arg2 === 'number' ? { promptTokens: arg2, completionTokens: arg3 ?? 0 } : arg2

    const override = this.overrides?.[modelId]
    const base = PRICING_BY_ID.get(modelId)

    const inputPrice = override?.inputPricePerMillion ?? base?.inputPricePerMillion
    const outputPrice = override?.outputPricePerMillion ?? base?.outputPricePerMillion
    const cacheWritePrice = override?.cacheWritePricePerMillion ?? base?.cacheWritePricePerMillion
    const cacheReadPrice = override?.cacheReadPricePerMillion ?? base?.cacheReadPricePerMillion

    const cacheCreation = usage.cacheCreationInputTokens ?? 0
    const cacheRead = usage.cacheReadInputTokens ?? 0

    let estimatedCostUsd = 0
    let pricingSource: TurnCost['pricingSource'] = 'unknown'

    if (inputPrice !== undefined && outputPrice !== undefined) {
      estimatedCostUsd =
        (usage.promptTokens / 1_000_000) * inputPrice +
        (usage.completionTokens / 1_000_000) * outputPrice +
        (cacheWritePrice !== undefined ? (cacheCreation / 1_000_000) * cacheWritePrice : 0) +
        (cacheReadPrice !== undefined ? (cacheRead / 1_000_000) * cacheReadPrice : 0)
      pricingSource = override ? 'override' : 'table'
    } else {
      this.handleMissing(modelId)
    }

    return {
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      estimatedCostUsd,
      pricingSource,
    }
  }

  private handleMissing(modelId: string): void {
    if (this.onMissing === 'throw') {
      throw new Error(
        `[Roy] No pricing for model "${modelId}". Add it via CostCalculatorConfig.pricingOverrides.${modelId}.`,
      )
    }
    if (this.onMissing === 'warn' && !this.warnedFor.has(modelId)) {
      this.warnedFor.add(modelId)
      this.logger.warn(
        `[Roy] No pricing for "${modelId}" (bundled table asOf ${PRICING_AS_OF}). ` +
          `Cost will be reported as 0. Pass CostCalculatorConfig.pricingOverrides to silence.`,
      )
    }
    // 'zero' falls through silently
  }

  /**
   * Summarize total cost across multiple turns.
   */
  summarize(turns: TurnCost[]): SessionCostSummary {
    const costByModel: Record<string, { tokens: number; costUsd: number }> = {}
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCostUsd = 0

    for (const turn of turns) {
      totalPromptTokens += turn.promptTokens
      totalCompletionTokens += turn.completionTokens
      totalCostUsd += turn.estimatedCostUsd

      const existing = costByModel[turn.modelId] ?? { tokens: 0, costUsd: 0 }
      existing.tokens += turn.promptTokens + turn.completionTokens
      existing.costUsd += turn.estimatedCostUsd
      costByModel[turn.modelId] = existing
    }

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalCostUsd,
      costByModel,
    }
  }

  /**
   * Look up model info from the pricing table.
   */
  getModelInfo(modelId: string): ModelInfo | undefined {
    return PRICING_BY_ID.get(modelId)
  }

  /**
   * List all known models, optionally filtered by provider.
   */
  listModels(provider?: ModelInfo['provider']): ModelInfo[] {
    return provider ? MODEL_PRICING.filter((m) => m.provider === provider) : MODEL_PRICING
  }

  /**
   * Format a cost as a human-readable string.
   * @example formatCost(0.00234) → "$0.0023"
   */
  static formatCost(usd: number): string {
    if (usd === 0) return '$0.00'
    if (usd < 0.001) return `$${usd.toExponential(2)}`
    return `$${usd.toFixed(4)}`
  }
}
