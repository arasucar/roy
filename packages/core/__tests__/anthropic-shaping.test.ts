import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  buildAnthropicMessages,
  buildAnthropicTools,
  buildAnthropicSystem,
  mapAnthropicStreamEvent,
} from '../src/providers/anthropic.js'
import type { Message } from '../src/types/message.js'
import type { StreamChunk } from '../src/types/message.js'
import type { ToolDefinition } from '../src/types/tool.js'

function msg(role: Message['role'], text: string): Message {
  return {
    id: 'm',
    role,
    content: [{ type: 'text', text }],
    createdAt: '2026-05-26T00:00:00Z',
  }
}

describe('buildAnthropicMessages', () => {
  it('attaches cache_control to the second-to-last message, NOT the newest user turn', () => {
    const out = buildAnthropicMessages(
      [msg('user', 'first'), msg('assistant', 'reply'), msg('user', 'second')],
      true,
    )
    expect(out.length).toBe(3)
    const sndLast = out[out.length - 2]!
    const sndLastLast = sndLast.content[sndLast.content.length - 1]!
    expect(sndLastLast.cache_control).toEqual({ type: 'ephemeral' })
    const newest = out[out.length - 1]!
    const newestLast = newest.content[newest.content.length - 1]!
    expect(newestLast.cache_control).toBeUndefined()
  })

  it('omits cache_control when caching disabled', () => {
    const out = buildAnthropicMessages(
      [msg('user', 'first'), msg('assistant', 'reply'), msg('user', 'second')],
      false,
    )
    for (const m of out) {
      for (const b of m.content) expect(b.cache_control).toBeUndefined()
    }
  })

  it('no-ops cache_control with a single message', () => {
    const out = buildAnthropicMessages([msg('user', 'only one')], true)
    expect(out[0]!.content[0]!.cache_control).toBeUndefined()
  })

  it('shapes assistant tool_use blocks and user tool_result blocks for follow-up turns', () => {
    const out = buildAnthropicMessages(
      [
        {
          ...msg('assistant', ''),
          content: [
            {
              type: 'tool_call',
              toolCall: {
                id: 'toolu_1',
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
                toolCallId: 'toolu_1',
                name: 'search',
                result: { title: 'Roy docs' },
              },
            },
          ],
        },
      ],
      false,
    )

    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search',
            input: { query: 'roy' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"title":"Roy docs"}',
          },
        ],
      },
    ])
  })

  it('marks Anthropic tool_result blocks as errors when tool execution failed', () => {
    const out = buildAnthropicMessages(
      [
        {
          ...msg('tool', ''),
          content: [
            {
              type: 'tool_result',
              toolResult: {
                toolCallId: 'toolu_1',
                name: 'search',
                result: { error: 'bad args' },
                isError: true,
              },
            },
          ],
        },
      ],
      false,
    )

    expect(out).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"error":"bad args"}',
            is_error: true,
          },
        ],
      },
    ])
  })
})

describe('buildAnthropicTools', () => {
  const tool = (name: string): ToolDefinition => ({
    name,
    description: name,
    parameters: z.object({ x: z.string() }),
    execute: async () => null,
  })

  it('attaches cache_control to the LAST tool, not the earlier ones', () => {
    const out = buildAnthropicTools([tool('a'), tool('b'), tool('c')], true)
    expect(out[0]!.cache_control).toBeUndefined()
    expect(out[1]!.cache_control).toBeUndefined()
    expect(out[2]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('uses the shared JSON Schema converter for nested input schemas', () => {
    const out = buildAnthropicTools(
      [
        {
          name: 'search',
          description: 'Search docs',
          parameters: z.object({
            query: z.string().describe('Search query'),
            tags: z.array(z.string()).default([]),
          }),
          execute: async () => null,
        },
      ],
      false,
    )

    expect(out[0]!.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          default: [],
        },
      },
      required: ['query'],
    })
  })

  it('returns [] for no tools', () => {
    expect(buildAnthropicTools(undefined, true)).toEqual([])
    expect(buildAnthropicTools([], true)).toEqual([])
  })
})

describe('buildAnthropicSystem', () => {
  it('returns plain string when caching disabled', () => {
    expect(buildAnthropicSystem('be helpful', false)).toBe('be helpful')
  })
  it('returns array form with cache_control when caching enabled', () => {
    const out = buildAnthropicSystem('be helpful', true)
    expect(Array.isArray(out)).toBe(true)
    expect((out as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
    })
  })
  it('returns undefined when no system prompt', () => {
    expect(buildAnthropicSystem(undefined, true)).toBeUndefined()
  })
})

describe('mapAnthropicStreamEvent', () => {
  it('preserves Anthropic tool_use IDs and names across JSON deltas', () => {
    const toolState = new Map()

    expect(
      mapAnthropicStreamEvent(
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search',
          },
        },
        toolState,
      ),
    ).toEqual([])

    expect(
      mapAnthropicStreamEvent(
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"query"',
          },
        },
        toolState,
      ),
    ).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'toolu_1',
        toolName: 'search',
        argumentsDelta: '{"query"',
      },
    ])
  })

  it('maps text deltas', () => {
    expect(
      mapAnthropicStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }),
    ).toEqual<StreamChunk[]>([{ type: 'text', delta: 'hello' }])
  })
})
