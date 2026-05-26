import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Orchestrator } from '../src/agents/orchestrator.js'
import { AgentRegistry } from '../src/agents/registry.js'
import type { LLMProvider, SendOptions } from '../src/providers/types.js'
import type { AgentDefinition } from '../src/types/agent.js'
import type { Message } from '../src/types/message.js'
import type { ChatSession } from '../src/types/session.js'
import type { ToolDefinition } from '../src/types/tool.js'

function message(role: Message['role'], text: string): Message {
  return {
    id: `${role}-1`,
    role,
    content: [{ type: 'text', text }],
    createdAt: '2026-05-26T00:00:00Z',
  }
}

function session(messages: Message[] = []): ChatSession {
  return {
    id: 'session_1',
    agentId: 'assistant',
    status: 'active',
    messages,
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
    createdAt: '2026-05-26T00:00:00Z',
    updatedAt: '2026-05-26T00:00:00Z',
  }
}

function assistantMessage(text: string): Message {
  return {
    id: `assistant-${text || 'empty'}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: '2026-05-26T00:00:00Z',
  }
}

class FakeToolProvider implements LLMProvider {
  readonly calls: SendOptions[] = []

  constructor(readonly type: string) {}

  async *stream(options: SendOptions) {
    this.calls.push(options)

    if (this.calls.length === 1) {
      yield {
        type: 'tool_call' as const,
        toolCallId: 'toolu_1',
        toolName: 'search',
        argumentsDelta: '{"query":"roy"}',
      }
      yield { type: 'usage' as const, promptTokens: 10, completionTokens: 2 }
      yield { type: 'done' as const, message: assistantMessage('') }
      return
    }

    yield { type: 'text' as const, delta: 'Found Roy docs.' }
    yield { type: 'usage' as const, promptTokens: 20, completionTokens: 5 }
    yield {
      type: 'done' as const,
      message: assistantMessage('Found Roy docs.'),
    }
  }

  estimateTokens(): number {
    return 0
  }

  contextWindowSize(): number {
    return 200_000
  }
}

describe('Orchestrator tool loops', () => {
  it.each(['anthropic', 'gemini'])(
    'feeds %s tool results back into a follow-up provider turn',
    async (providerType) => {
      const searchTool: ToolDefinition = {
        name: 'search',
        description: 'Search docs',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ title: `Docs for ${query}` }),
      }
      const agent: AgentDefinition = {
        id: 'assistant',
        name: 'Assistant',
        provider:
          providerType === 'anthropic'
            ? { type: 'anthropic', apiKey: 'test-key' }
            : { type: 'gemini', apiKey: 'test-key' },
        model:
          providerType === 'anthropic'
            ? 'claude-sonnet-4-6'
            : 'gemini-1.5-flash',
        systemPrompt: 'Use tools when useful.',
        tools: [searchTool],
      }
      const provider = new FakeToolProvider(providerType)
      const orchestrator = new Orchestrator(new AgentRegistry([agent]))
      vi.spyOn(orchestrator, 'getProvider').mockReturnValue(provider)

      const emitted = []
      for await (const chunk of orchestrator.runTurn(
        agent,
        session(),
        message('user', 'Find Roy docs'),
      )) {
        emitted.push(chunk)
      }

      expect(provider.calls).toHaveLength(2)
      expect(provider.calls[1]!.messages).toMatchObject([
        { role: 'user', content: [{ type: 'text', text: 'Find Roy docs' }] },
        {
          role: 'assistant',
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
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolResult: {
                toolCallId: 'toolu_1',
                name: 'search',
                result: { title: 'Docs for roy' },
              },
            },
          ],
        },
      ])
      expect(emitted).toContainEqual({
        type: 'tool_result',
        toolCallId: 'toolu_1',
        toolName: 'search',
        result: { title: 'Docs for roy' },
      })
      expect(
        emitted
          .filter((chunk) => chunk.type === 'text')
          .map((chunk) => chunk.delta)
          .join(''),
      ).toBe('Found Roy docs.')
      expect(emitted.at(-1)?.type).toBe('done')
    },
  )
})
