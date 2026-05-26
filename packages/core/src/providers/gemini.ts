import type { LLMProvider, SendOptions } from './types.js'
import type { StreamChunk, Message } from '../types/message.js'
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
    const model = genAI.getGenerativeModel({
      model: options.model,
      ...(options.systemPrompt !== undefined
        ? { systemInstruction: options.systemPrompt }
        : {}),
    })

    const history = options.messages
      .filter((m) => m.role !== 'system')
      .slice(0, -1)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          {
            text: m.content
              .filter((b) => b.type === 'text')
              .map((b) => (b as any).text)
              .join('\n'),
          },
        ],
      }))

    const lastMessage = options.messages[options.messages.length - 1]
    const userText = lastMessage?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text)
      .join('\n') ?? ''

    const chat = model.startChat({ history })
    const result = await chat.sendMessageStream(userText)

    let fullText = ''
    let promptTokens = 0
    let completionTokens = 0

    for await (const chunk of result.stream) {
      const text = chunk.text()
      fullText += text
      if (text) yield { type: 'text', delta: text }
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
