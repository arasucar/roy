import type { ModelInfo, ProviderType } from '../types/provider.js'

/**
 * The date these prices were last reviewed. Treat the bundled table as
 * best-effort and override via CostCalculatorConfig.pricingOverrides for
 * production billing — provider prices drift constantly.
 */
export const PRICING_AS_OF = '2026-05-26'

/**
 * Published pricing table.
 * All prices are USD per 1,000,000 tokens.
 * Override via CostCalculatorConfig.pricingOverrides.
 */
export const MODEL_PRICING: ModelInfo[] = [
  // ── Anthropic ────────────────────────────────────────────────────────────
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputPricePerMillion: 15.0,
    outputPricePerMillion: 75.0,
    cacheWritePricePerMillion: 18.75,
    cacheReadPricePerMillion: 1.5,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputPricePerMillion: 3.0,
    outputPricePerMillion: 15.0,
    cacheWritePricePerMillion: 3.75,
    cacheReadPricePerMillion: 0.3,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputPricePerMillion: 0.8,
    outputPricePerMillion: 4.0,
    cacheWritePricePerMillion: 1.0,
    cacheReadPricePerMillion: 0.08,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputPricePerMillion: 3.0,
    outputPricePerMillion: 15.0,
    cacheWritePricePerMillion: 3.75,
    cacheReadPricePerMillion: 0.3,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
  },
  // ── OpenAI ───────────────────────────────────────────────────────────────
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    inputPricePerMillion: 5.0,
    outputPricePerMillion: 15.0,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'o3',
    name: 'o3',
    provider: 'openai',
    contextWindow: 200_000,
    inputPricePerMillion: 10.0,
    outputPricePerMillion: 40.0,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    provider: 'openai',
    contextWindow: 200_000,
    inputPricePerMillion: 1.1,
    outputPricePerMillion: 4.4,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'o1',
    name: 'o1',
    provider: 'openai',
    contextWindow: 200_000,
    inputPricePerMillion: 15.0,
    outputPricePerMillion: 60.0,
    supportsToolUse: true,
    supportsStreaming: false,
  },
  // ── Google Gemini ─────────────────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 2_000_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10.0,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gemini',
    contextWindow: 1_000_000,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.4,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'gemini',
    contextWindow: 2_000_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.0,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'gemini',
    contextWindow: 1_000_000,
    inputPricePerMillion: 0.075,
    outputPricePerMillion: 0.3,
    supportsToolUse: true,
    supportsStreaming: true,
  },
  // ── Ollama (local — no cost) ──────────────────────────────────────────────
  {
    id: 'llama3',
    name: 'Llama 3 (local)',
    provider: 'ollama',
    contextWindow: 8_192,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    supportsToolUse: false,
    supportsStreaming: true,
  },
  {
    id: 'mistral',
    name: 'Mistral (local)',
    provider: 'ollama',
    contextWindow: 8_192,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    supportsToolUse: false,
    supportsStreaming: true,
  },
]

export const PRICING_BY_ID: Map<string, ModelInfo> = new Map(
  MODEL_PRICING.map((m) => [m.id, m]),
)

export const PRICING_BY_PROVIDER: Map<ProviderType, ModelInfo[]> = new Map()
for (const model of MODEL_PRICING) {
  const list = PRICING_BY_PROVIDER.get(model.provider) ?? []
  list.push(model)
  PRICING_BY_PROVIDER.set(model.provider, list)
}
