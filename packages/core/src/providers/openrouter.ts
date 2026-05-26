import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import type { ToolDefinition } from '../types/tool.js'
import type { ObjectJsonSchema } from './json-schema.js'
import { zodToObjectJsonSchema } from './json-schema.js'
import { generateId } from '../utils/id.js'

const CONTEXT_WINDOWS: Record<string, number> = {
  'openai/gpt-4o-mini': 128_000,
  'openai/gpt-4o': 128_000,
}

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
    const body = buildOpenRouterBody(options, this.fallbackModel)
    const headers = buildOpenRouterHeaders(
      this.apiKey,
      this.appName,
      this.siteUrl,
    )

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    )

    if (!response.ok) {
      const err = await response.text()
      yield {
        type: 'error',
        error: new Error(`[OpenRouter] ${response.status}: ${err}`),
      }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      yield {
        type: 'error',
        error: new Error('[OpenRouter] No response body'),
      }
      return
    }

    const decoder = new TextDecoder()
    let fullText = ''
    let promptTokens = 0
    let completionTokens = 0
    let emittedUsage = false
    const toolState = new Map<number, OpenRouterToolState>()

    let buffered = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''

      for (const chunk of parseOpenRouterLines(lines, toolState)) {
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
      for (const chunk of parseOpenRouterLines([buffered], toolState)) {
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
    // OpenRouter serves many models; known defaults are model-aware and
    // everything else falls back to a conservative common window.
    return CONTEXT_WINDOWS[_model] ?? 128_000
  }
}

// ─── OpenRouter body shaping ─────────────────────────────────────────────────

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenRouterToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ObjectJsonSchema
  }
}

interface OpenRouterRequestBody extends Record<string, unknown> {
  model: string
  messages: OpenRouterMessage[]
  stream: true
  max_tokens: number
  stream_options: { include_usage: true }
  temperature?: number
  tools?: OpenRouterToolDef[]
  models?: string[]
}

interface OpenRouterToolState {
  id?: string
  name?: string
}

interface OpenRouterChunk {
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

export function buildOpenRouterMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenRouterMessage[] {
  const out: OpenRouterMessage[] = []
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

export function buildOpenRouterTools(
  tools: ToolDefinition[] | undefined,
): OpenRouterToolDef[] {
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

export function buildOpenRouterBody(
  options: SendOptions,
  fallbackModel?: string,
): OpenRouterRequestBody {
  const tools = buildOpenRouterTools(options.tools)
  return {
    model: options.model,
    messages: buildOpenRouterMessages(options.messages, options.systemPrompt),
    stream: true,
    max_tokens: options.maxTokens ?? 4096,
    stream_options: { include_usage: true },
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(fallbackModel !== undefined
      ? { models: [options.model, fallbackModel] }
      : {}),
  }
}

export function buildOpenRouterHeaders(
  apiKey: string,
  appName?: string,
  siteUrl?: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(appName !== undefined ? { 'X-Title': appName } : {}),
    ...(siteUrl !== undefined ? { 'HTTP-Referer': siteUrl } : {}),
  }
}

function* parseOpenRouterLines(
  lines: string[],
  toolState: Map<number, OpenRouterToolState>,
): Iterable<StreamChunk> {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const json = trimmed.slice(5).trim()
    if (!json || json === '[DONE]') continue

    let parsed: OpenRouterChunk
    try {
      parsed = JSON.parse(json) as OpenRouterChunk
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
