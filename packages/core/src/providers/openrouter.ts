import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import { generateId } from '../utils/id.js'

/**
 * OpenRouter provider — routes to any model via OpenRouter's OpenAI-compatible API.
 * Supports automatic fallback models.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly type = 'openrouter'

  constructor(
    private readonly apiKey: string,
    private readonly fallbackModel?: string,
    private readonly appName?: string,
    private readonly siteUrl?: string,
  ) {}

  async *stream(options: SendOptions): AsyncIterable<StreamChunk> {
    const messages: { role: string; content: string }[] = []

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt })
    }
    for (const msg of options.messages) {
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text as string)
        .join('\n')
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: text,
      })
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      temperature: options.temperature,
      max_tokens: options.maxTokens ?? 4096,
    }

    if (this.fallbackModel) {
      body['models'] = [options.model, this.fallbackModel]
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
    if (this.appName) headers['X-Title'] = this.appName
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!response.ok) {
      const err = await response.text()
      yield { type: 'error', error: new Error(`[OpenRouter] ${response.status}: ${err}`) }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', error: new Error('[OpenRouter] No response body') }
      return
    }

    const decoder = new TextDecoder()
    let fullText = ''
    let promptTokens = 0
    let completionTokens = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6)
        if (json === '[DONE]') continue
        try {
          const parsed = JSON.parse(json)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) {
            fullText += delta
            yield { type: 'text', delta }
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? 0
            completionTokens = parsed.usage.completion_tokens ?? 0
          }
        } catch {
          // skip malformed
        }
      }
    }

    yield { type: 'usage', promptTokens, completionTokens }
    yield {
      type: 'done',
      message: {
        id: generateId(),
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        createdAt: new Date().toISOString(),
        cost: { promptTokens, completionTokens, estimatedCostUsd: 0 },
      },
    }
  }

  estimateTokens(messages: Message[], systemPrompt?: string): number {
    const text = [systemPrompt ?? '', ...messages.map((m) =>
      m.content.map((b) => ('text' in b ? (b as any).text : '')).join(' '),
    )].join(' ')
    return Math.ceil(text.length / 4)
  }

  contextWindowSize(_model: string): number {
    // OpenRouter serves many models — return a reasonable default
    return 128_000
  }
}
