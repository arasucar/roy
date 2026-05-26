import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  OpenRouterProvider,
  buildOpenRouterBody,
  buildOpenRouterHeaders,
  buildOpenRouterMessages,
  buildOpenRouterTools,
} from '../src/providers/openrouter.js'
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

describe('buildOpenRouterMessages', () => {
  it('puts system prompt first and maps non-assistant messages to user', () => {
    const out = buildOpenRouterMessages(
      [msg('system', 'ignored system'), msg('user', 'hello'), msg('assistant', 'hi')],
      'be useful',
    )
    expect(out).toEqual([
      { role: 'system', content: 'be useful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('shapes assistant tool calls and tool results for follow-up turns', () => {
    const out = buildOpenRouterMessages([
      {
        ...msg('assistant', ''),
        content: [
          {
            type: 'tool_call',
            toolCall: {
              id: 'call_1',
              name: 'search',
              arguments: '{"query":"roy"}',
            },
          },
        ],
      },
      {
        ...msg('tool', ''),
        content: [
          {
            type: 'tool_result',
            toolResult: {
              toolCallId: 'call_1',
              name: 'search',
              result: { title: 'Roy docs' },
            },
          },
        ],
      },
    ])

    expect(out).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"query":"roy"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"title":"Roy docs"}',
      },
    ])
  })
})

describe('buildOpenRouterTools', () => {
  it('shapes Zod tools as OpenAI-compatible function tools', () => {
    const out = buildOpenRouterTools([searchTool])
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

  it('returns [] for no tools', () => {
    expect(buildOpenRouterTools(undefined)).toEqual([])
    expect(buildOpenRouterTools([])).toEqual([])
  })
})

describe('buildOpenRouterBody', () => {
  it('omits unset optionals and includes fallback model, tools, and usage streaming', () => {
    const body = buildOpenRouterBody(
      {
        model: 'openai/gpt-4o-mini',
        systemPrompt: 'be useful',
        messages: [msg('user', 'hello')],
        tools: [searchTool],
        maxTokens: 123,
      },
      'openai/gpt-4o',
    )

    expect(body).toMatchObject({
      model: 'openai/gpt-4o-mini',
      stream: true,
      max_tokens: 123,
      stream_options: { include_usage: true },
      models: ['openai/gpt-4o-mini', 'openai/gpt-4o'],
      messages: [
        { role: 'system', content: 'be useful' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(body.tools).toHaveLength(1)
    expect(body).not.toHaveProperty('temperature')
  })
})

describe('buildOpenRouterHeaders', () => {
  it('includes optional leaderboard headers only when supplied', () => {
    expect(buildOpenRouterHeaders('key')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer key',
    })
    expect(buildOpenRouterHeaders('key', 'Roy', 'https://roy.local')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer key',
      'X-Title': 'Roy',
      'HTTP-Referer': 'https://roy.local',
    })
  })
})

describe('OpenRouterProvider.stream', () => {
  it('preserves streamed tool names across later argument deltas', async () => {
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
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
          },
        }),
      ),
    )

    const provider = new OpenRouterProvider('key')
    const emitted: StreamChunk[] = []
    for await (const chunk of provider.stream({
      model: 'openai/gpt-4o-mini',
      messages: [msg('user', 'hello')],
      tools: [searchTool],
    })) {
      emitted.push(chunk)
    }

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
