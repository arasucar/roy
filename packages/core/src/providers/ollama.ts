import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import type { ToolDefinition } from '../types/tool.js'
import type { ObjectJsonSchema } from './json-schema.js'
import { zodToObjectJsonSchema } from './json-schema.js'
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
    const body = buildOllamaBody(options)

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    if (!response.ok) {
      const err = await response.text()
      yield {
        type: 'error',
        error: new Error(`[Ollama] ${response.status}: ${err}`),
      }
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
    let emittedUsage = false
    const toolState = new Map<number, OllamaToolState>()

    let buffered = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''

      for (const chunk of parseOllamaLines(lines, toolState)) {
        if (chunk.type === 'text') fullText += chunk.delta
        if (chunk.type === 'usage') {
          promptTokens = chunk.promptTokens
          completionTokens = chunk.completionTokens
          emittedUsage = true
        }
        yield chunk
      }
    }

    if (buffered.trim()) {
      for (const chunk of parseOllamaLines([buffered], toolState)) {
        if (chunk.type === 'text') fullText += chunk.delta
        if (chunk.type === 'usage') {
          promptTokens = chunk.promptTokens
          completionTokens = chunk.completionTokens
          emittedUsage = true
        }
        yield chunk
      }
    }

    if (!emittedUsage) {
      yield { type: 'usage', promptTokens, completionTokens }
    }
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

// ─── Ollama body shaping ─────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ObjectJsonSchema
  }
}

interface OllamaRequestBody extends Record<string, unknown> {
  model: string
  messages: OllamaMessage[]
  stream: true
  max_tokens?: number
  temperature?: number
  tools?: OllamaToolDef[]
}

interface OllamaToolState {
  id?: string
  name?: string
}

interface OllamaChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  } | null
}

export function buildOllamaMessages(
  messages: Message[],
  systemPrompt?: string,
): OllamaMessage[] {
  const out: OllamaMessage[] = []
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    out.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    })
  }

  return out
}

export function buildOllamaTools(
  tools: ToolDefinition[] | undefined,
): OllamaToolDef[] {
  if (!tools || tools.length === 0) return []
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToObjectJsonSchema(t.parameters),
    },
  }))
}

export function buildOllamaBody(options: SendOptions): OllamaRequestBody {
  const tools = buildOllamaTools(options.tools)
  return {
    model: options.model,
    messages: buildOllamaMessages(options.messages, options.systemPrompt),
    stream: true,
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

function* parseOllamaLines(
  lines: string[],
  toolState: Map<number, OllamaToolState>,
): Iterable<StreamChunk> {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const json = trimmed.slice(5).trim()
    if (!json || json === '[DONE]') continue

    let parsed: OllamaChunk
    try {
      parsed = JSON.parse(json) as OllamaChunk
    } catch {
      continue
    }

    const delta = parsed.choices?.[0]?.delta
    if (delta?.content) {
      yield { type: 'text', delta: delta.content }
    }

    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0
      const state = toolState.get(index) ?? {}
      if (tc.id !== undefined) state.id = tc.id
      if (tc.function?.name !== undefined) state.name = tc.function.name
      toolState.set(index, state)

      const argumentsDelta = tc.function?.arguments
      if (argumentsDelta) {
        yield {
          type: 'tool_call',
          toolCallId: state.id ?? `tc_${index}`,
          toolName: state.name ?? '',
          argumentsDelta,
        }
      }
    }

    if (parsed.usage) {
      yield {
        type: 'usage',
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
      }
    }
  }
}
