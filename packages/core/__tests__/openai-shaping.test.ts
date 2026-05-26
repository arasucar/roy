import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOpenAIMessages,
  buildOpenAIRequest,
  buildOpenAITools,
  mapOpenAIStreamChunk,
} from '../src/providers/openai.js'
import type { Message } from '../src/types/message.js'
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

describe('buildOpenAIMessages', () => {
  it('puts system prompt first and maps non-assistant messages to user', () => {
    const out = buildOpenAIMessages(
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

  it('shapes assistant tool calls and tool results for follow-up turns', () => {
    const out = buildOpenAIMessages([
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

describe('buildOpenAITools', () => {
  it('shapes Zod tools as OpenAI-compatible function tools', () => {
    const out = buildOpenAITools([searchTool])
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

describe('buildOpenAIRequest', () => {
  it('omits unset optionals and includes tools plus usage streaming', () => {
    const body = buildOpenAIRequest({
      model: 'gpt-4o-mini',
      systemPrompt: 'be useful',
      messages: [msg('user', 'hello')],
      tools: [searchTool],
      maxTokens: 123,
    })

    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      stream: true,
      max_tokens: 123,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'be useful' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(body.tools).toHaveLength(1)
    expect(body).not.toHaveProperty('temperature')
  })
})

describe('mapOpenAIStreamChunk', () => {
  it('preserves streamed tool names across later argument deltas', () => {
    const toolState = new Map()
    expect(
      mapOpenAIStreamChunk(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'search' },
                  },
                ],
              },
            },
          ],
        },
        toolState,
      ),
    ).toEqual([])

    expect(
      mapOpenAIStreamChunk(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"query"' },
                  },
                ],
              },
            },
          ],
        },
        toolState,
      ),
    ).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'search',
        argumentsDelta: '{"query"',
      },
    ])
  })

  it('maps text and usage chunks', () => {
    expect(
      mapOpenAIStreamChunk({
        choices: [{ delta: { content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    ).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', promptTokens: 12, completionTokens: 3 },
    ])
  })
})
