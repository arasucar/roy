import type { ProviderConfig } from '../types/provider.js'
import type { LLMProvider } from './types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { GeminiProvider } from './gemini.js'
import { OllamaProvider } from './ollama.js'
import { OpenRouterProvider } from './openrouter.js'

/**
 * Factory function — creates the correct LLMProvider from a ProviderConfig.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config.apiKey, config.baseUrl)
    case 'openai':
      return new OpenAIProvider(config.apiKey, config.baseUrl, config.organization)
    case 'gemini':
      return new GeminiProvider(config.apiKey)
    case 'ollama':
      return new OllamaProvider(config.baseUrl)
    case 'openrouter':
      return new OpenRouterProvider(
        config.apiKey,
        config.fallbackModel,
        config.appName,
        config.siteUrl,
      )
    default:
      throw new Error(`[Roy] Unknown provider type: ${(config as ProviderConfig).type}`)
  }
}
