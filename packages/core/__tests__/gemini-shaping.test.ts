import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildGeminiContents,
  buildGeminiHistory,
  buildGeminiModelParams,
  buildGeminiStartChatParams,
  buildGeminiTools,
  buildGeminiUserText,
  mapGeminiStreamChunk,
} from '../src/providers/gemini.js'
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
    query: z.string().describe('Search query'),
    limit: z.number().int().optional(),
    includeDrafts: z.boolean().default(false),
    metadata: z
      .object({
        owner: z.string().nullable(),
      })
      .optional(),
  }),
  execute: async () => null,
}

describe('buildGeminiContents', () => {
  it('skips system messages and maps assistant to model', () => {
    const out = buildGeminiContents([
      msg('system', 'ignored system'),
      msg('user', 'hello'),
      msg('assistant', 'hi'),
    ])

    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ])
  })
})

describe('buildGeminiHistory', () => {
  it('keeps prior non-system turns and leaves the latest user turn out', () => {
    const out = buildGeminiHistory([
      msg('user', 'first'),
      msg('assistant', 'second'),
      msg('user', 'third'),
    ])

    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'second' }] },
    ])
  })
})

describe('buildGeminiUserText', () => {
  it('uses the last non-system message text', () => {
    const out = buildGeminiUserText([
      msg('user', 'hello'),
      msg('system', 'ignored'),
    ])

    expect(out).toBe('hello')
  })
})

describe('buildGeminiTools', () => {
  it('shapes Zod tools as Gemini function declarations', () => {
    const out = buildGeminiTools([searchTool])

    expect(out).toEqual([
      {
        functionDeclarations: [
          {
            name: 'search',
            description: 'Search docs',
            parameters: {
              type: 'OBJECT',
              properties: {
                query: { type: 'STRING', description: 'Search query' },
                limit: { type: 'INTEGER' },
                includeDrafts: { type: 'BOOLEAN' },
                metadata: {
                  type: 'OBJECT',
                  properties: {
                    owner: { type: 'STRING', nullable: true },
                  },
                  required: ['owner'],
                },
              },
              required: ['query'],
            },
          },
        ],
      },
    ])
  })
})

describe('buildGeminiModelParams', () => {
  it('omits unset optionals and includes tools plus generation config', () => {
    const body = buildGeminiModelParams({
      model: 'gemini-1.5-flash',
      systemPrompt: 'be useful',
      messages: [msg('user', 'hello')],
      tools: [searchTool],
      maxTokens: 123,
    })

    expect(body).toMatchObject({
      model: 'gemini-1.5-flash',
      systemInstruction: 'be useful',
      generationConfig: { maxOutputTokens: 123 },
    })
    expect(body.tools).toHaveLength(1)
    expect(body.generationConfig).not.toHaveProperty('temperature')
  })
})

describe('buildGeminiStartChatParams', () => {
  it('passes history separately from the latest user turn', () => {
    const out = buildGeminiStartChatParams({
      model: 'gemini-1.5-flash',
      messages: [msg('user', 'hello'), msg('user', 'latest')],
    })

    expect(out).toEqual({
      history: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })
  })
})

describe('mapGeminiStreamChunk', () => {
  it('maps text chunks', () => {
    expect(mapGeminiStreamChunk({ text: () => 'hello' })).toEqual([
      { type: 'text', delta: 'hello' },
    ])
  })

  it('maps function calls into Roy tool call chunks', () => {
    expect(
      mapGeminiStreamChunk({
        text: () => '',
        functionCalls: () => [{ name: 'search', args: { query: 'roy' } }],
      }),
    ).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tc_0',
        toolName: 'search',
        argumentsDelta: '{"query":"roy"}',
      },
    ])
  })
})
