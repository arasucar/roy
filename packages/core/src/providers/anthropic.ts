import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
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
    const system = buildAnthropicSystem(options.systemPrompt, this.enableCaching)

    let promptTokens = 0
    let completionTokens = 0
    let cacheCreationInputTokens = 0
    let cacheReadInputTokens = 0
    let fullText = ''
    const toolNames = new Map<number, string>()

    const stream = client.messages.stream({
      model: options.model,
      messages: anthropicMessages,
      max_tokens: options.maxTokens ?? 4096,
      ...(system !== undefined ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    })

    if (options.signal) {
      options.signal.addEventListener('abort', () => stream.abort())
    }

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolNames.set(event.index, event.content_block.name)
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          fullText += event.delta.text
          yield { type: 'text', delta: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          yield {
            type: 'tool_call',
            toolCallId: `tc_${event.index}`,
            toolName: toolNames.get(event.index) ?? '',
            argumentsDelta: event.delta.partial_json,
          }
        }
      } else if (event.type === 'message_delta' && event.usage) {
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

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicTextPart[]
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

export function buildAnthropicMessages(
  messages: Message[],
  enableCaching: boolean,
): AnthropicMessage[] {
  const out: AnthropicMessage[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [
      {
        type: 'text',
        text: m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      },
    ],
  }))

  // Cache the prior context: attach a breakpoint to the LAST block of the
  // second-to-last message. The brand-new user turn stays cache-control-free
  // so it doesn't bust the cache prefix.
  if (enableCaching && out.length >= 2) {
    const target = out[out.length - 2]!
    const blocks = target.content
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]!
      blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    }
  }

  return out
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
      input_schema: zodToJsonSchema(t.parameters),
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
): string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined {
  if (!systemPrompt) return undefined
  if (!enableCaching) return systemPrompt
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
}

// Minimal Zod → JSON Schema conversion for tool definitions
function zodToJsonSchema(schema: import('zod').ZodTypeAny): AnthropicInputSchema {
  // In production use zod-to-json-schema package for full coverage
  const shape = (schema as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.() ?? {}
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const def = (value as { _def?: { typeName?: string } })._def
    properties[key] = { type: zodTypeName(def) }
    if (!def?.typeName?.includes('Optional')) {
      required.push(key)
    }
  }

  return { type: 'object', properties, required }
}

function zodTypeName(def: { typeName?: string } | undefined): string {
  const name: string = def?.typeName ?? ''
  if (name.includes('String')) return 'string'
  if (name.includes('Number')) return 'number'
  if (name.includes('Boolean')) return 'boolean'
  if (name.includes('Array')) return 'array'
  return 'string'
}
