import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChat } from '../src/index.js'
import type { StreamChunk } from '../src/types/message.js'

function mockOpenRouterStream(chunks: string[]) {
  const encoder = new TextEncoder()
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
    ),
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
})
