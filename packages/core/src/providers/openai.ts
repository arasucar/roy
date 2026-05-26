import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
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
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3': 200_000,
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
      baseURL: this.baseUrl,
      organization: this.organization,
    })

    const openaiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []

    if (options.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt })
    }

    for (const msg of options.messages) {
      if (msg.role === 'system') continue
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text as string)
        .join('\n')
      openaiMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: text,
      })
    }

    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object' },
      },
    }))

    let promptTokens = 0
    let completionTokens = 0
    let fullText = ''

    const streamResponse = await client.chat.completions.create({
      model: options.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    })

    if (options.signal) {
      options.signal.addEventListener('abort', () => streamResponse.controller.abort())
    }

    for await (const chunk of streamResponse) {
      const delta = chunk.choices[0]?.delta
      if (delta?.content) {
        fullText += delta.content
        yield { type: 'text', delta: delta.content }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.arguments) {
            yield {
              type: 'tool_call',
              toolCallId: tc.id ?? generateId(),
              toolName: tc.function.name ?? '',
              argumentsDelta: tc.function.arguments,
            }
          }
        }
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens
        completionTokens = chunk.usage.completion_tokens
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

  contextWindowSize(model: string): number {
    return CONTEXT_WINDOWS[model] ?? 128_000
  }
}
