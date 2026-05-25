// ─── Provider config discriminated union ─────────────────────────────────────

export interface AnthropicConfig {
  type: 'anthropic'
  apiKey: string
  baseUrl?: string
  /** Default: 'claude-sonnet-4-6' — overridden by AgentDefinition.model */
  defaultModel?: string
}

export interface OpenAIConfig {
  type: 'openai'
  apiKey: string
  baseUrl?: string
  organization?: string
  /** Default: 'gpt-4o' */
  defaultModel?: string
}

export interface GeminiConfig {
  type: 'gemini'
  apiKey: string
  /** Default: 'gemini-1.5-pro' */
  defaultModel?: string
}

export interface OllamaConfig {
  type: 'ollama'
  /** Default: 'http://localhost:11434' */
  baseUrl?: string
  /** Default: 'llama3' */
  defaultModel?: string
}

export interface OpenRouterConfig {
  type: 'openrouter'
  apiKey: string
  /** Fallback model if the primary fails */
  fallbackModel?: string
  /** App name sent in X-Title header */
  appName?: string
  siteUrl?: string
}

export type ProviderConfig =
  | AnthropicConfig
  | OpenAIConfig
  | GeminiConfig
  | OllamaConfig
  | OpenRouterConfig

export type ProviderType = ProviderConfig['type']

// ─── Model info ───────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderType
  contextWindow: number
  /** USD per 1M input tokens */
  inputPricePerMillion: number
  /** USD per 1M output tokens */
  outputPricePerMillion: number
  /** USD per 1M tokens written to prompt cache. Anthropic only. */
  cacheWritePricePerMillion?: number
  /** USD per 1M tokens read from prompt cache. Anthropic only. */
  cacheReadPricePerMillion?: number
  supportsToolUse: boolean
  supportsStreaming: boolean
  /** Whether the provider supports cache_control breakpoints. */
  supportsPromptCaching?: boolean
}
