import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import { generateId } from '../utils/id.js'

/**
 * Ollama provider — uses the OpenAI-compatible /v1/chat/completions endpoint
 * that Ollama exposes. No extra SDK dependency needed.
 */
export class OllamaProvider implements LLMProvider {
  readonly type = 'ollama'
  private readonly baseUrl: string

  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

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
      messages.push({ role: msg.role, content: text })
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        temperature: options.temperature,
      }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    if (!response.ok) {
      const err = await response.text()
      yield { type: 'error', error: new Error(`[Ollama] ${response.status}: ${err}`) }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', error: new Error('[Ollama] No response body') }
      return
    }

    const decoder = new TextDecoder()
    let fullText = ''
    let promptTokens = 0
    let completionTokens = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const lines = decoder.decode(value).split('\n')
      for (const line of lines) {
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
          // malformed chunk — skip
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
    const text = [
      systemPrompt ?? '',
      ...messages.map((m) =>
        m.content.map((b) => ('text' in b ? (b as any).text : '')).join(' '),
      ),
    ].join(' ')
    return Math.ceil(text.length / 4)
  }

  contextWindowSize(_model: string): number {
    // Ollama doesn't expose context sizes via API — return a safe default
    return 8_192
  }
}
