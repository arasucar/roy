import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createChat } from '../src/index.js'
import type { StreamChunk } from '../src/types/message.js'
import type { ToolDefinition } from '../src/types/tool.js'

function openRouterResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  )
}

function mockOpenRouterStream(chunks: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    openRouterResponse(chunks),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createChat OpenRouter integration', () => {
  it('streams a turn, calculates cost, and persists session messages', async () => {
    const fetchSpy = mockOpenRouterStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" from Roy"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n',
      'data: [DONE]\n\n',
    ])

    const roy = createChat({
      agents: [
        {
          id: 'assistant',
          name: 'Assistant',
          provider: {
            type: 'openrouter',
            apiKey: 'test-key',
            appName: 'Roy Tests',
            siteUrl: 'https://roy.local',
          },
          model: 'openai/gpt-4o-mini',
          systemPrompt: 'Be concise.',
        },
      ],
    })

    const emitted: StreamChunk[] = []
    for await (const chunk of roy.send({
      input: 'Say hello',
      metadata: { source: 'integration-test' },
    })) {
      emitted.push(chunk)
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0]!
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'X-Title': 'Roy Tests',
      'HTTP-Referer': 'https://roy.local',
    })

    const body = JSON.parse(init?.body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
      stream_options?: { include_usage?: boolean }
    }
    expect(body).toMatchObject({
      model: 'openai/gpt-4o-mini',
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Say hello' },
      ],
    })

    const text = emitted
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text' }> =>
          chunk.type === 'text',
      )
      .map((chunk) => chunk.delta)
      .join('')
    expect(text).toBe('Hello from Roy')
    expect(emitted.filter((chunk) => chunk.type === 'usage')).toHaveLength(1)

    const done = emitted.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'done' }> =>
        chunk.type === 'done',
    )
    expect(done?.message.agentId).toBe('assistant')
    expect(done?.message.cost).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
    })
    expect(done?.message.cost?.estimatedCostUsd).toBeCloseTo(0.000027, 10)

    const [session] = await roy.listSessions()
    expect(session?.messages).toHaveLength(2)
    expect(session?.messages[0]?.role).toBe('user')
    expect(session?.messages[0]?.metadata).toEqual({
      source: 'integration-test',
    })
    expect(session?.messages[1]?.role).toBe('assistant')
    expect(session?.cumulativeTokens).toBe(120)
    expect(session?.cumulativeCostUsd).toBeCloseTo(0.000027, 10)
  })

  it('executes streamed tool calls, feeds results back, and persists the tool loop', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        openRouterResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"roy\\"}"}}]}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        openRouterResponse([
          'data: {"choices":[{"delta":{"content":"Found Roy docs."}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\n',
          'data: [DONE]\n\n',
        ]),
      )

    const searchTool: ToolDefinition = {
      name: 'search',
      description: 'Search docs',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ title: `Docs for ${query}` }),
    }

    const roy = createChat({
      agents: [
        {
          id: 'assistant',
          name: 'Assistant',
          provider: {
            type: 'openrouter',
            apiKey: 'test-key',
          },
          model: 'openai/gpt-4o-mini',
          systemPrompt: 'Use tools when useful.',
          tools: [searchTool],
        },
      ],
    })

    const emitted: StreamChunk[] = []
    for await (const chunk of roy.send({ input: 'Find Roy docs' })) {
      emitted.push(chunk)
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(fetchSpy.mock.calls[1]![1]?.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(secondBody.messages).toMatchObject([
      { role: 'system', content: 'Use tools when useful.' },
      { role: 'user', content: 'Find Roy docs' },
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
        content: '{"title":"Docs for roy"}',
      },
    ])

    expect(emitted.filter((chunk) => chunk.type === 'tool_result')).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'call_1',
        toolName: 'search',
        result: { title: 'Docs for roy' },
      },
    ])
    expect(
      emitted
        .filter(
          (chunk): chunk is Extract<StreamChunk, { type: 'text' }> =>
            chunk.type === 'text',
        )
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('Found Roy docs.')
    expect(emitted.filter((chunk) => chunk.type === 'usage')).toHaveLength(2)

    const done = emitted.find(
      (chunk): chunk is Extract<StreamChunk, { type: 'done' }> =>
        chunk.type === 'done',
    )
    expect(done?.message.cost).toMatchObject({
      promptTokens: 30,
      completionTokens: 7,
    })
    expect(done?.message.cost?.estimatedCostUsd).toBeCloseTo(0.0000087, 10)

    const [session] = await roy.listSessions()
    expect(session?.messages).toHaveLength(4)
    expect(session?.messages[1]?.content[0]?.type).toBe('tool_call')
    expect(session?.messages[2]?.role).toBe('tool')
    expect(session?.messages[3]?.role).toBe('assistant')
    expect(session?.cumulativeTokens).toBe(37)
    expect(session?.cumulativeCostUsd).toBeCloseTo(0.0000087, 10)
  })
})
