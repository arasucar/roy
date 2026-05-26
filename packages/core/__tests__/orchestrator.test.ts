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

class FakePlanProvider implements LLMProvider {
  readonly type = 'openrouter'
  readonly calls: SendOptions[] = []

  async *stream(options: SendOptions) {
    this.calls.push(options)

    if (this.calls.length === 1) {
      yield { type: 'text' as const, delta: 'I have enough information. [PLAN_READY]' }
      yield { type: 'usage' as const, promptTokens: 10, completionTokens: 2 }
      yield {
        type: 'done' as const,
        message: assistantMessage('I have enough information. [PLAN_READY]'),
      }
      return
    }

    yield {
      type: 'text' as const,
      delta: JSON.stringify({
        title: 'Search plan',
        goal: 'Find Roy docs',
        steps: [
          {
            order: 1,
            title: 'Search docs',
            description: 'Search for Roy documentation',
            hasSideEffects: false,
          },
        ],
        constraints: ['Use read-only search'],
      }),
    }
    yield { type: 'usage' as const, promptTokens: 20, completionTokens: 5 }
    yield { type: 'done' as const, message: assistantMessage('') }
  }

  estimateTokens(): number {
    return 0
  }

  contextWindowSize(): number {
    return 128_000
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

describe('Orchestrator plan mode', () => {
  it('emits plan-ready before awaiting approval and then emits plan-approved before done', async () => {
    const events: string[] = []
    let readyBeforeApproval = false
    const agent: AgentDefinition = {
      id: 'assistant',
      name: 'Assistant',
      provider: { type: 'openrouter', apiKey: 'test-key' },
      model: 'openai/gpt-4o-mini',
      systemPrompt: 'Plan before acting.',
      planMode: true,
      onPlanApproval: async () => {
        readyBeforeApproval = events.includes('ready')
        events.push('approval-callback')
        return { approved: true }
      },
    }
    const provider = new FakePlanProvider()
    const orchestrator = new Orchestrator(new AgentRegistry([agent]))
    vi.spyOn(orchestrator, 'getProvider').mockReturnValue(provider)
    orchestrator.on('plan-ready', ({ plan }) => {
      events.push('ready')
      expect(plan.status).toBe('pending_approval')
      expect(plan.title).toBe('Search plan')
    })
    orchestrator.on('plan-approved', ({ plan }) => {
      events.push('approved')
      expect(plan.status).toBe('approved')
    })

    const emitted = []
    for await (const chunk of orchestrator.runTurn(
      agent,
      session(),
      message('user', 'Find Roy docs'),
    )) {
      if (chunk.type === 'done') events.push('done')
      emitted.push(chunk)
    }

    expect(provider.calls).toHaveLength(2)
    expect(readyBeforeApproval).toBe(true)
    expect(events).toEqual(['ready', 'approval-callback', 'approved', 'done'])
    expect(emitted.at(-1)?.type).toBe('done')
  })

  it('emits plan-rejected when the approval callback rejects the drafted plan', async () => {
    const events: string[] = []
    const agent: AgentDefinition = {
      id: 'assistant',
      name: 'Assistant',
      provider: { type: 'openrouter', apiKey: 'test-key' },
      model: 'openai/gpt-4o-mini',
      systemPrompt: 'Plan before acting.',
      planMode: true,
      onPlanApproval: async () => ({
        approved: false,
        rejectionReason: 'Needs a safer approach',
      }),
    }
    const provider = new FakePlanProvider()
    const orchestrator = new Orchestrator(new AgentRegistry([agent]))
    vi.spyOn(orchestrator, 'getProvider').mockReturnValue(provider)
    orchestrator.on('plan-ready', () => events.push('ready'))
    orchestrator.on('plan-rejected', ({ plan }) => {
      events.push('rejected')
      expect(plan.status).toBe('rejected')
      expect(plan.rejectionReason).toBe('Needs a safer approach')
    })

    for await (const chunk of orchestrator.runTurn(
      agent,
      session(),
      message('user', 'Find Roy docs'),
    )) {
      if (chunk.type === 'done') events.push('done')
    }

    expect(events).toEqual(['ready', 'rejected', 'done'])
  })
})
