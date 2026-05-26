import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  OllamaProvider,
  buildOllamaBody,
  buildOllamaMessages,
  buildOllamaTools,
} from '../src/providers/ollama.js'
import type { Message, StreamChunk } from '../src/types/message.js'
import type { ToolDefinition } from '../src/types/tool.js'

function msg(role: Message['role'], text: string): Message {
  return {
    id: 'm',
    role,
    content: [{ type: 'text', text }],
    createdAt: '2026-05-26T00:00:00Z',
  }
}

const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Search docs',
  parameters: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  execute: async () => null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildOllamaMessages', () => {
  it('puts system prompt first and maps non-assistant messages to user', () => {
    const out = buildOllamaMessages(
      [
        msg('system', 'ignored system'),
        msg('user', 'hello'),
        msg('assistant', 'hi'),
      ],
      'be useful',
    )
    expect(out).toEqual([
      { role: 'system', content: 'be useful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })
})

describe('buildOllamaTools', () => {
  it('shapes Zod tools as OpenAI-compatible function tools', () => {
    const out = buildOllamaTools([searchTool])
    expect(out[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search docs',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
    })
  })
})

describe('buildOllamaBody', () => {
  it('omits unset optionals and includes tools when provided', () => {
    const body = buildOllamaBody({
      model: 'llama3',
      systemPrompt: 'be useful',
      messages: [msg('user', 'hello')],
      tools: [searchTool],
      maxTokens: 123,
    })

    expect(body).toMatchObject({
      model: 'llama3',
      stream: true,
      max_tokens: 123,
      messages: [
        { role: 'system', content: 'be useful' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(body.tools).toHaveLength(1)
    expect(body).not.toHaveProperty('temperature')
  })
})

describe('OllamaProvider.stream', () => {
  it('buffers split SSE chunks and preserves streamed tool names', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"roy\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const joined = chunks.join('')
            controller.enqueue(encoder.encode(joined.slice(0, 25)))
            controller.enqueue(encoder.encode(joined.slice(25)))
            controller.close()
          },
        }),
      ),
    )

    const provider = new OllamaProvider('http://localhost:11434/')
    const emitted: StreamChunk[] = []
    for await (const chunk of provider.stream({
      model: 'llama3',
      messages: [msg('user', 'hello')],
      tools: [searchTool],
    })) {
      emitted.push(chunk)
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(emitted.filter((c) => c.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'search',
        argumentsDelta: '{"query"',
      },
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'search',
        argumentsDelta: ':"roy"}',
      },
    ])
    expect(emitted).toContainEqual({ type: 'text', delta: 'done' })
    expect(emitted).toContainEqual({
      type: 'usage',
      promptTokens: 12,
      completionTokens: 3,
    })
    expect(emitted.filter((c) => c.type === 'usage')).toHaveLength(1)
    expect(emitted.at(-1)?.type).toBe('done')
  })
})
