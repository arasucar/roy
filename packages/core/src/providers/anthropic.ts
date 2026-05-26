import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import { zodToObjectJsonSchema } from './json-schema.js'
import { generateId } from '../utils/id.js'

// Lazy import — only required if user installs @anthropic-ai/sdk
async function getAnthropic() {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    return Anthropic
  } catch {
    throw new Error(
      '[Roy] @anthropic-ai/sdk is required for the Anthropic provider. Run: npm install @anthropic-ai/sdk',
    )
  }
}

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
}

export interface AnthropicProviderOptions {
  /** Custom base URL (e.g. proxy / staging). */
  baseUrl?: string
  /**
   * Whether to attach `cache_control: { type: 'ephemeral' }` breakpoints to
   * the system prompt, the last tool def, and the second-to-last message.
   * Default `true`. Disable if you suspect prompt cache misbehaviour.
   */
  enablePromptCaching?: boolean
}

export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic'

  private readonly enableCaching: boolean

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl?: string,
    options?: AnthropicProviderOptions,
  ) {
    // Back-compat with positional baseUrl; if options.baseUrl is set it wins.
    if (options?.baseUrl !== undefined) this.baseUrl = options.baseUrl
    this.enableCaching = options?.enablePromptCaching ?? true
  }

  async *stream(options: SendOptions): AsyncIterable<StreamChunk> {
    const Anthropic = await getAnthropic()
    const client = new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseUrl !== undefined ? { baseURL: this.baseUrl } : {}),
    })

    const anthropicMessages = buildAnthropicMessages(
      options.messages.filter((m) => m.role !== 'system'),
      this.enableCaching,
    )

    const tools = buildAnthropicTools(options.tools, this.enableCaching)
    const system = buildAnthropicSystem(
      options.systemPrompt,
      this.enableCaching,
    )

    let promptTokens = 0
    let completionTokens = 0
    let cacheCreationInputTokens = 0
    let cacheReadInputTokens = 0
    let fullText = ''
    const toolState = new Map<number, AnthropicToolState>()

    const stream = client.messages.stream({
      model: options.model,
      messages: anthropicMessages,
      max_tokens: options.maxTokens ?? 4096,
      ...(system !== undefined ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
    })

    if (options.signal) {
      options.signal.addEventListener('abort', () => stream.abort())
    }

    for await (const event of stream) {
      if (event.type === 'message_delta' && event.usage) {
        completionTokens = event.usage.output_tokens
      } else if (event.type === 'message_start' && event.message.usage) {
        const u = event.message.usage as {
          input_tokens?: number
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
        }
        promptTokens = u.input_tokens ?? 0
        cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0
        cacheReadInputTokens = u.cache_read_input_tokens ?? 0
      }

      for (const mapped of mapAnthropicStreamEvent(
        event as AnthropicStreamEventLike,
        toolState,
      )) {
        if (mapped.type === 'text') fullText += mapped.delta
        yield mapped
      }
    }

    yield {
      type: 'usage',
      promptTokens,
      completionTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    }

    const finalMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: [{ type: 'text', text: fullText }],
      createdAt: new Date().toISOString(),
      cost: {
        promptTokens,
        completionTokens,
        estimatedCostUsd: 0, // filled by CostCalculator after this
        cacheCreationInputTokens,
        cacheReadInputTokens,
      },
    }

    yield { type: 'done', message: finalMessage }
  }

  estimateTokens(messages: Message[], systemPrompt?: string): number {
    const text = [
      systemPrompt ?? '',
      ...messages.map((m) =>
        m.content.map((b) => ('text' in b ? b.text : '')).join(' '),
      ),
    ].join(' ')
    // ~4 chars per token heuristic
    return Math.ceil(text.length / 4)
  }

  contextWindowSize(model: string): number {
    return CONTEXT_WINDOWS[model] ?? 100_000
  }
}

// ─── Anthropic body shaping ───────────────────────────────────────────────────

interface AnthropicTextPart {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicToolResultPart {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  cache_control?: { type: 'ephemeral' }
}

type AnthropicContentPart =
  | AnthropicTextPart
  | AnthropicToolUsePart
  | AnthropicToolResultPart

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentPart[]
}

interface AnthropicInputSchema extends Record<string, unknown> {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
}

interface AnthropicToolDef {
  name: string
  description: string
  input_schema: AnthropicInputSchema
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicToolState {
  id?: string
  name?: string
}

interface AnthropicStreamEventLike {
  type?: string
  index?: number
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
  }
}

export function buildAnthropicMessages(
  messages: Message[],
  enableCaching: boolean,
): AnthropicMessage[] {
  const out = messages.flatMap(buildAnthropicMessage)

  // Cache the prior context: attach a breakpoint to the LAST block of the
  // second-to-last message. The brand-new user turn stays cache-control-free
  // so it doesn't bust the cache prefix.
  if (enableCaching && out.length >= 2) {
    const target = out[out.length - 2]!
    const blocks = target.content
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]!
      blocks[blocks.length - 1] = {
        ...last,
        cache_control: { type: 'ephemeral' },
      }
    }
  }

  return out
}

function buildAnthropicMessage(msg: Message): AnthropicMessage[] {
  if (msg.role === 'system') return []

  if (msg.role === 'tool') {
    const content = msg.content
      .filter((b) => b.type === 'tool_result')
      .map((b): AnthropicToolResultPart => {
        const block: AnthropicToolResultPart = {
          type: 'tool_result',
          tool_use_id: b.toolResult.toolCallId,
          content: serializeToolResult(b.toolResult.result),
        }
        if (b.toolResult.isError !== undefined) {
          block.is_error = b.toolResult.isError
        }
        return block
      })

    return content.length > 0 ? [{ role: 'user', content }] : []
  }

  const content: AnthropicContentPart[] = []
  for (const block of msg.content) {
    if (block.type === 'text' || block.type === 'summary') {
      content.push({ type: 'text', text: block.text })
    } else if (msg.role === 'assistant' && block.type === 'tool_call') {
      content.push({
        type: 'tool_use',
        id: block.toolCall.id,
        name: block.toolCall.name,
        input: parseToolInput(block.toolCall.arguments),
      })
    }
  }

  return [
    {
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    },
  ]
}

export function buildAnthropicTools(
  tools: SendOptions['tools'],
  enableCaching: boolean,
): AnthropicToolDef[] {
  if (!tools || tools.length === 0) return []
  return tools.map((t, i) => {
    const def: AnthropicToolDef = {
      name: t.name,
      description: t.description,
      input_schema: zodToObjectJsonSchema(t.parameters),
    }
    // Anthropic treats a cache_control breakpoint as "everything up to and
    // including this item is cached" — so attaching it to the LAST tool
    // covers all of them.
    if (enableCaching && i === tools.length - 1) {
      def.cache_control = { type: 'ephemeral' }
    }
    return def
  })
}

export function buildAnthropicSystem(
  systemPrompt: string | undefined,
  enableCaching: boolean,
):
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  | undefined {
  if (!systemPrompt) return undefined
  if (!enableCaching) return systemPrompt
  return [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ]
}

export function mapAnthropicStreamEvent(
  event: AnthropicStreamEventLike,
  toolState = new Map<number, AnthropicToolState>(),
): StreamChunk[] {
  const out: StreamChunk[] = []

  if (
    event.type === 'content_block_start' &&
    event.content_block?.type === 'tool_use'
  ) {
    const index = event.index ?? 0
    const state = toolState.get(index) ?? {}
    if (event.content_block.id !== undefined) state.id = event.content_block.id
    if (event.content_block.name !== undefined) {
      state.name = event.content_block.name
    }
    toolState.set(index, state)
  }

  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      out.push({ type: 'text', delta: event.delta.text })
    } else if (
      event.delta?.type === 'input_json_delta' &&
      event.delta.partial_json
    ) {
      const index = event.index ?? 0
      const state = toolState.get(index) ?? {}
      out.push({
        type: 'tool_call',
        toolCallId: state.id ?? `tc_${index}`,
        toolName: state.name ?? '',
        argumentsDelta: event.delta.partial_json,
      })
    }
  }

  return out
}

function parseToolInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // Fall through to the conservative empty object required by Anthropic.
  }
  return {}
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
