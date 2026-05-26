import { describe, it, expect, vi } from 'vitest'
import { CostCalculator } from '../src/cost/calculator.js'

describe('CostCalculator', () => {
  it('computes input + output cost for a known model', () => {
    const c = new CostCalculator()
    const cost = c.calculate('openai/gpt-4o-mini', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    })
    expect(cost.pricingSource).toBe('table')
    expect(cost.estimatedCostUsd).toBeCloseTo(0.75, 5) // 0.15 input + 0.60 output
  })

  it('applies cache pricing for Anthropic when usage includes cache fields', () => {
    const c = new CostCalculator()
    const cost = c.calculate('claude-sonnet-4-6', {
      promptTokens: 0,
      completionTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    })
    // Bundled prices: cacheWrite 3.75, cacheRead 0.3
    expect(cost.estimatedCostUsd).toBeCloseTo(3.75 + 0.3, 5)
    expect(cost.cacheCreationInputTokens).toBe(1_000_000)
    expect(cost.cacheReadInputTokens).toBe(1_000_000)
  })

  it("warns once when model isn't in the table (default 'warn')", () => {
    const warn = vi.fn()
    const c = new CostCalculator({ logger: { warn } })
    const a = c.calculate('vendor-X-1', { promptTokens: 100, completionTokens: 100 })
    const b = c.calculate('vendor-X-1', { promptTokens: 200, completionTokens: 200 })
    expect(a.pricingSource).toBe('unknown')
    expect(a.estimatedCostUsd).toBe(0)
    expect(b.pricingSource).toBe('unknown')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("throws when onMissingModel='throw'", () => {
    const c = new CostCalculator({ onMissingModel: 'throw' })
    expect(() => c.calculate('unknown', { promptTokens: 1, completionTokens: 1 })).toThrow(
      /No pricing/,
    )
  })

  it("is silent when onMissingModel='zero'", () => {
    const warn = vi.fn()
    const c = new CostCalculator({ onMissingModel: 'zero', logger: { warn } })
    const cost = c.calculate('unknown', { promptTokens: 100, completionTokens: 100 })
    expect(cost.estimatedCostUsd).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('caller pricing overrides bundled defaults', () => {
    const c = new CostCalculator({
      pricingOverrides: {
        'openai/gpt-4o-mini': { inputPricePerMillion: 1.0, outputPricePerMillion: 2.0 },
      },
    })
    const cost = c.calculate('openai/gpt-4o-mini', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    })
    expect(cost.pricingSource).toBe('override')
    expect(cost.estimatedCostUsd).toBeCloseTo(3.0, 5)
  })

  it('supports the legacy positional call shape', () => {
    const c = new CostCalculator()
    const cost = c.calculate('openai/gpt-4o-mini', 1_000_000, 1_000_000)
    expect(cost.estimatedCostUsd).toBeCloseTo(0.75, 5)
  })

  it('exposes pricingAsOf', () => {
    const c = new CostCalculator()
    expect(c.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('lists OpenRouter models for default app configuration', () => {
    const c = new CostCalculator()
    expect(c.listModels('openrouter').map((m) => m.id)).toContain('openai/gpt-4o-mini')
  })
})
