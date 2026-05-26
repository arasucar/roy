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
      buildGeminiUserRequest(options.messages) as Parameters<
        typeof chat.sendMessageStream
      >[0],
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

interface GeminiFunctionCallPart {
  functionCall: {
    name: string
    args: Record<string, unknown>
  }
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string
    response: Record<string, unknown>
  }
}

type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
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
  description?: string
  nullable?: boolean
  enum?: string[]
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

type GeminiUserRequest = string | GeminiPart[]

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
    const parts = buildGeminiParts(msg)
    if (parts.length === 0) continue
    out.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts,
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

export function buildGeminiUserRequest(messages: Message[]): GeminiUserRequest {
  const last = lastNonSystemMessage(messages)
  if (!last || last.role !== 'tool') return buildGeminiUserText(messages)

  const parts = buildGeminiParts(last)
  return parts.length > 0 ? parts : ''
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

function buildGeminiParts(msg: Message): GeminiPart[] {
  const parts: GeminiPart[] = []

  for (const block of msg.content) {
    if (block.type === 'text' || block.type === 'summary') {
      parts.push({ text: block.text })
    } else if (msg.role === 'assistant' && block.type === 'tool_call') {
      parts.push({
        functionCall: {
          name: block.toolCall.name,
          args: parseToolArgs(block.toolCall.arguments),
        },
      })
    } else if (msg.role === 'tool' && block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          name: block.toolResult.name,
          response: toFunctionResponse(block.toolResult.result),
        },
      })
    }
  }

  return parts
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
    type?: string | string[]
    description?: string
    enum?: string[]
    properties?: Record<string, unknown>
    items?: unknown
    required?: string[]
    anyOf?: unknown[]
  }
  const normalized = normalizeJsonSchemaProperty(schema)
  const out: GeminiSchema = { type: normalized.type }

  if (normalized.nullable) {
    out.nullable = true
  }
  if (normalized.description !== undefined) {
    out.description = normalized.description
  }
  if (normalized.enum !== undefined) {
    out.enum = normalized.enum
  }

  if (normalized.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, child]) => [
        key,
        jsonSchemaPropertyToGeminiSchema(child),
      ]),
    )
  }
  if (normalized.items !== undefined) {
    out.items = jsonSchemaPropertyToGeminiSchema(normalized.items)
  }
  if (normalized.required !== undefined && normalized.required.length > 0) {
    out.required = normalized.required
  }

  return out
}

function normalizeJsonSchemaProperty(schema: {
  type?: string | string[]
  description?: string
  enum?: string[]
  properties?: Record<string, unknown>
  items?: unknown
  required?: string[]
  anyOf?: unknown[]
}): {
  type: GeminiSchemaType
  nullable: boolean
  description?: string
  enum?: string[]
  properties?: Record<string, unknown>
  items?: unknown
  required?: string[]
} {
  const variants = schema.anyOf
    ?.filter(isRecord)
    .filter((item) => item.type !== 'null')
  const fallback = variants?.[0]
  const rawType = schemaTypeValue(fallback?.type) ?? schema.type
  const nullable =
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    schema.anyOf?.some((item) => isRecord(item) && item.type === 'null') === true

  return {
    type: jsonSchemaTypeToGeminiType(rawType),
    nullable,
    ...(schema.description !== undefined
      ? { description: schema.description }
      : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
    ...(fallback?.properties !== undefined
      ? { properties: fallback.properties as Record<string, unknown> }
      : schema.properties !== undefined
        ? { properties: schema.properties }
        : {}),
    ...(fallback?.items !== undefined
      ? { items: fallback.items }
      : schema.items !== undefined
        ? { items: schema.items }
        : {}),
    ...(fallback?.required !== undefined
      ? { required: Array.isArray(fallback.required) ? fallback.required : [] }
      : schema.required !== undefined
        ? { required: schema.required }
        : {}),
  }
}

function jsonSchemaTypeToGeminiType(
  type: string | string[] | undefined,
): GeminiSchemaType {
  const normalized = Array.isArray(type)
    ? type.find((item) => item !== 'null')
    : type
  if (normalized === 'number') return 'NUMBER'
  if (normalized === 'integer') return 'INTEGER'
  if (normalized === 'boolean') return 'BOOLEAN'
  if (normalized === 'array') return 'ARRAY'
  if (normalized === 'object') return 'OBJECT'
  return 'STRING'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaTypeValue(
  value: unknown,
): string | string[] | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
  }
  return undefined
}

function readGeminiText(chunk: GeminiStreamChunkLike): string {
  try {
    return chunk.text?.() ?? ''
  } catch {
    return ''
  }
}

function lastNonSystemMessage(messages: Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'system') {
      return messages[index]
    }
  }
  return undefined
}

function parseToolArgs(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // Gemini requires functionCall.args to be an object.
  }
  return {}
}

function toFunctionResponse(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result
  return { result }
}
