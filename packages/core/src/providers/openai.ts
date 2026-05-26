import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import type { ToolDefinition } from '../types/tool.js'
import type { ObjectJsonSchema } from './json-schema.js'
import { zodToObjectJsonSchema } from './json-schema.js'
import { generateId } from '../utils/id.js'

async function getOpenAI() {
  try {
    const { default: OpenAI } = await import('openai')
    return OpenAI
  } catch {
    throw new Error(
      '[Roy] openai is required for the OpenAI provider. Run: npm install openai',
    )
  }
}

const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  o1: 200_000,
  'o1-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
}

export class OpenAIProvider implements LLMProvider {
  readonly type = 'openai'

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl?: string,
    private readonly organization?: string,
  ) {}

  async *stream(options: SendOptions): AsyncIterable<StreamChunk> {
    const OpenAI = await getOpenAI()
    const client = new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseUrl !== undefined ? { baseURL: this.baseUrl } : {}),
      ...(this.organization !== undefined
        ? { organization: this.organization }
        : {}),
    })

    let promptTokens = 0
    let completionTokens = 0
    let fullText = ''
    let emittedUsage = false
    const toolState = new Map<number, OpenAIToolState>()

    const streamResponse = await client.chat.completions.create(
      buildOpenAIRequest(options),
    )

    if (options.signal) {
      options.signal.addEventListener('abort', () =>
        streamResponse.controller.abort(),
      )
    }

    for await (const chunk of streamResponse) {
      for (const mapped of mapOpenAIStreamChunk(chunk, toolState)) {
        if (mapped.type === 'text') fullText += mapped.delta
        if (mapped.type === 'usage') {
          promptTokens = mapped.promptTokens
          completionTokens = mapped.completionTokens
          emittedUsage = true
        }
        yield mapped
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

  contextWindowSize(model: string): number {
    return CONTEXT_WINDOWS[model] ?? 128_000
  }
}

// ─── OpenAI body shaping ─────────────────────────────────────────────────────

type OpenAIMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIAssistantToolCall[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
    }

interface OpenAIAssistantToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ObjectJsonSchema
  }
}

interface OpenAIRequestBody extends Record<string, unknown> {
  model: string
  messages: OpenAIMessage[]
  stream: true
  max_tokens: number
  stream_options: { include_usage: true }
  temperature?: number
  tools?: OpenAIToolDef[]
}

interface OpenAIToolState {
  id?: string
  name?: string
}

interface OpenAIStreamChunk {
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

export function buildOpenAIMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue
    out.push(...buildOpenAIMessage(msg))
  }

  return out
}

function buildOpenAIMessage(msg: Message): OpenAIMessage[] {
  if (msg.role === 'tool') {
    return msg.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({
        role: 'tool' as const,
        tool_call_id: b.toolResult.toolCallId,
        content: serializeToolResult(b.toolResult.result),
      }))
  }

  const text = messageText(msg)
  const toolCalls = msg.content
    .filter((b) => b.type === 'tool_call')
    .map((b): OpenAIAssistantToolCall => ({
      id: b.toolCall.id,
      type: 'function',
      function: {
        name: b.toolCall.name,
        arguments: b.toolCall.arguments,
      },
    }))

  if (msg.role === 'assistant' && toolCalls.length > 0) {
    return [
      {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls,
      },
    ]
  }

  return [
    {
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    },
  ]
}

export function buildOpenAITools(
  tools: ToolDefinition[] | undefined,
): OpenAIToolDef[] {
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

export function buildOpenAIRequest(options: SendOptions): OpenAIRequestBody {
  const tools = buildOpenAITools(options.tools)
  return {
    model: options.model,
    messages: buildOpenAIMessages(options.messages, options.systemPrompt),
    stream: true,
    max_tokens: options.maxTokens ?? 4096,
    stream_options: { include_usage: true },
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

export function mapOpenAIStreamChunk(
  chunk: OpenAIStreamChunk,
  toolState = new Map<number, OpenAIToolState>(),
): StreamChunk[] {
  const out: StreamChunk[] = []
  const delta = chunk.choices?.[0]?.delta

  if (delta?.content) {
    out.push({ type: 'text', delta: delta.content })
  }

  for (const tc of delta?.tool_calls ?? []) {
    const index = tc.index ?? 0
    const state = toolState.get(index) ?? {}
    if (tc.id !== undefined) state.id = tc.id
    if (tc.function?.name !== undefined) state.name = tc.function.name
    toolState.set(index, state)

    const argumentsDelta = tc.function?.arguments
    if (argumentsDelta) {
      out.push({
        type: 'tool_call',
        toolCallId: state.id ?? `tc_${index}`,
        toolName: state.name ?? '',
        argumentsDelta,
      })
    }
  }

  if (chunk.usage) {
    out.push({
      type: 'usage',
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
    })
  }

  return out
}

function messageText(msg: Message): string {
  return msg.content
    .flatMap((b) =>
      b.type === 'text' || b.type === 'summary' ? [b.text] : [],
    )
    .join('\n')
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
