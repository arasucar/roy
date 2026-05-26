import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
import type { ToolDefinition } from '../types/tool.js'
import type { ObjectJsonSchema } from './json-schema.js'
import { zodToObjectJsonSchema } from './json-schema.js'
import { generateId } from '../utils/id.js'

async function getGoogleAI() {
  try {
    const mod = await import('@google/generative-ai')
    return mod
  } catch {
    throw new Error(
      '[Roy] @google/generative-ai is required for the Gemini provider. Run: npm install @google/generative-ai',
    )
  }
}

const CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-1.5-flash-8b': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 2_000_000,
}

export class GeminiProvider implements LLMProvider {
  readonly type = 'gemini'

  constructor(private readonly apiKey: string) {}

  async *stream(options: SendOptions): AsyncIterable<StreamChunk> {
    const { GoogleGenerativeAI } = await getGoogleAI()
    const genAI = new GoogleGenerativeAI(this.apiKey)
    const model = genAI.getGenerativeModel(
      buildGeminiModelParams(options) as unknown as Parameters<
        typeof genAI.getGenerativeModel
      >[0],
    )
    const chat = model.startChat(buildGeminiStartChatParams(options))
    const result = await chat.sendMessageStream(
      buildGeminiUserText(options.messages),
    )

    let fullText = ''
    let promptTokens = 0
    let completionTokens = 0

    for await (const chunk of result.stream) {
      for (const mapped of mapGeminiStreamChunk(chunk)) {
        if (mapped.type === 'text') fullText += mapped.delta
        yield mapped
      }
    }

    const finalResponse = await result.response
    promptTokens = finalResponse.usageMetadata?.promptTokenCount ?? 0
    completionTokens = finalResponse.usageMetadata?.candidatesTokenCount ?? 0

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

  contextWindowSize(model: string): number {
    return CONTEXT_WINDOWS[model] ?? 1_000_000
  }
}

// ─── Gemini body shaping ─────────────────────────────────────────────────────

interface GeminiTextPart {
  text: string
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiTextPart[]
}

type GeminiSchemaType =
  | 'STRING'
  | 'NUMBER'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'ARRAY'
  | 'OBJECT'

interface GeminiSchema {
  type: GeminiSchemaType
  properties?: Record<string, GeminiSchema>
  items?: GeminiSchema
  required?: string[]
}

interface GeminiToolDef {
  functionDeclarations: Array<{
    name: string
    description?: string
    parameters: GeminiSchema
  }>
}

interface GeminiModelParams extends Record<string, unknown> {
  model: string
  systemInstruction?: string
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
  }
  tools?: GeminiToolDef[]
}

interface GeminiStartChatParams {
  history: GeminiContent[]
}

interface GeminiFunctionCall {
  name: string
  args?: object
}

interface GeminiStreamChunkLike {
  text?: () => string
  functionCalls?: () => GeminiFunctionCall[] | undefined
}

export function buildGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue
    out.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text: msg.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
        },
      ],
    })
  }

  return out
}

export function buildGeminiHistory(messages: Message[]): GeminiContent[] {
  return buildGeminiContents(messages).slice(0, -1)
}

export function buildGeminiUserText(messages: Message[]): string {
  let last: Message | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'system') {
      last = messages[index]
      break
    }
  }

  return (
    last?.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n') ?? ''
  )
}

export function buildGeminiTools(
  tools: ToolDefinition[] | undefined,
): GeminiToolDef[] {
  if (!tools || tools.length === 0) return []
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: jsonSchemaToGeminiSchema(zodToObjectJsonSchema(t.parameters)),
      })),
    },
  ]
}

export function buildGeminiModelParams(
  options: SendOptions,
): GeminiModelParams {
  const tools = buildGeminiTools(options.tools)
  const generationConfig = buildGeminiGenerationConfig(options)

  return {
    model: options.model,
    ...(options.systemPrompt !== undefined
      ? { systemInstruction: options.systemPrompt }
      : {}),
    ...(generationConfig !== undefined ? { generationConfig } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

export function buildGeminiStartChatParams(
  options: SendOptions,
): GeminiStartChatParams {
  return { history: buildGeminiHistory(options.messages) }
}

export function mapGeminiStreamChunk(
  chunk: GeminiStreamChunkLike,
): StreamChunk[] {
  const out: StreamChunk[] = []
  const text = readGeminiText(chunk)
  if (text) {
    out.push({ type: 'text', delta: text })
  }

  const functionCalls = chunk.functionCalls?.() ?? []
  functionCalls.forEach((call, index) => {
    out.push({
      type: 'tool_call',
      toolCallId: `tc_${index}`,
      toolName: call.name,
      argumentsDelta: JSON.stringify(call.args ?? {}),
    })
  })

  return out
}

function buildGeminiGenerationConfig(
  options: SendOptions,
): GeminiModelParams['generationConfig'] | undefined {
  const generationConfig: NonNullable<GeminiModelParams['generationConfig']> = {}
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens
  }
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature
  }

  return Object.keys(generationConfig).length > 0 ? generationConfig : undefined
}

function jsonSchemaToGeminiSchema(schema: ObjectJsonSchema): GeminiSchema {
  const out: GeminiSchema = {
    type: 'OBJECT',
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        jsonSchemaPropertyToGeminiSchema(value),
      ]),
    ),
  }

  if (schema.required.length > 0) {
    out.required = schema.required
  }

  return out
}

function jsonSchemaPropertyToGeminiSchema(value: unknown): GeminiSchema {
  const schema = value as {
    type?: string
    properties?: Record<string, unknown>
    items?: unknown
    required?: string[]
  }
  const type = jsonSchemaTypeToGeminiType(schema.type)
  const out: GeminiSchema = { type }

  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        jsonSchemaPropertyToGeminiSchema(child),
      ]),
    )
  }
  if (schema.items !== undefined) {
    out.items = jsonSchemaPropertyToGeminiSchema(schema.items)
  }
  if (schema.required !== undefined && schema.required.length > 0) {
    out.required = schema.required
  }

  return out
}

function jsonSchemaTypeToGeminiType(type: string | undefined): GeminiSchemaType {
  if (type === 'number') return 'NUMBER'
  if (type === 'integer') return 'INTEGER'
  if (type === 'boolean') return 'BOOLEAN'
  if (type === 'array') return 'ARRAY'
  if (type === 'object') return 'OBJECT'
  return 'STRING'
}

function readGeminiText(chunk: GeminiStreamChunkLike): string {
  try {
    return chunk.text?.() ?? ''
  } catch {
    return ''
  }
}
