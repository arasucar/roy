import { describe, it, expect } from 'vitest'
import { RollingCompactor, type CompactionEvent } from '../src/context/rolling.js'
import type { LLMProvider } from '../src/providers/types.js'
import type { ChatSession } from '../src/types/session.js'
import type { Message, StreamChunk } from '../src/types/message.js'
import type { CompactionStrategy } from '../src/context/types.js'

function fakeProvider(opts?: { window?: number; summaryDelta?: string }): LLMProvider {
  return {
    type: 'fake',
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text', delta: opts?.summaryDelta ?? 'short summary' }
      yield { type: 'usage', promptTokens: 0, completionTokens: 10 }
      yield {
        type: 'done',
        message: {
          id: 'm',
          role: 'assistant',
          content: [{ type: 'text', text: opts?.summaryDelta ?? 'short summary' }],
          createdAt: '',
        },
      }
    },
    estimateTokens: () => 0,
    contextWindowSize: () => opts?.window ?? 200_000,
  }
}

function session(cumulativeTokens: number, messages: Message[] = []): ChatSession {
  return {
    id: 's1',
    agentId: 'a',
    status: 'active',
    messages,
    cumulativeTokens,
    cumulativeCostUsd: 0,
    createdAt: '',
    updatedAt: '',
  }
}

function textMsg(role: Message['role'], text: string): Message {
  return { id: text.slice(0, 4), role, content: [{ type: 'text', text }], createdAt: '' }
}

describe('RollingCompactor — % watermark', () => {
  it('skips compaction below trigger', async () => {
    const c = new RollingCompactor({
      triggerFraction: 0.6,
      targetFraction: 0.4,
      reserveOutputTokens: 8192,
      provider: fakeProvider(),
      summaryModel: 'openai/gpt-4o-mini',
      toolTruncation: false,
    })
    const before = session(1000, [textMsg('user', 'hi')])
    const after = await c.maybeCompact(before, fakeProvider(), 'openai/gpt-4o-mini')
    expect(after).toBe(before)
  })

  it('triggers when cumulativeTokens crosses the % budget', async () => {
    // 200k window − 8k reserve = 192k input budget. 60% trigger = ~115k.
    const c = new RollingCompactor({
      triggerFraction: 0.6,
      targetFraction: 0.4,
      provider: fakeProvider(),
      summaryModel: 'openai/gpt-4o-mini',
      toolTruncation: false,
    })
    const budget = c.budget(fakeProvider(), 'openai/gpt-4o-mini')
    expect(budget.triggerAt).toBeGreaterThan(100_000)
    expect(budget.triggerAt).toBeLessThan(120_000)
    const before = session(budget.triggerAt + 100, [
      textMsg('user', 'a'),
      textMsg('assistant', 'b'),
      textMsg('user', 'c'),
      textMsg('assistant', 'd'),
    ])
    const events: CompactionEvent[] = []
    c.on('compacted', (e) => events.push(e))
    await c.maybeCompact(before, fakeProvider(), 'openai/gpt-4o-mini')
    expect(events.some((e) => e.step === 'summarized')).toBe(true)
  })

  it('respects legacy watermarkTokens when set', async () => {
    const c = new RollingCompactor({
      watermarkTokens: 5_000,
      provider: fakeProvider(),
      summaryModel: 'openai/gpt-4o-mini',
      toolTruncation: false,
    })
    const budget = c.budget(fakeProvider(), 'openai/gpt-4o-mini')
    expect(budget.triggerAt).toBe(5_000)
  })
})

describe('RollingCompactor — escalation order', () => {
  it('runs the strategy step and emits a compacted event', async () => {
    // A strategy that always succeeds, freeing some tokens.
    const strat: CompactionStrategy = {
      descriptorId: 'fake',
      canCompact: () => true,
      compact: async (messages) => ({
        messages: messages.slice(-2),
        tokensFreed: 50_000,
        summary: 'fake summary',
      }),
    }
    const c = new RollingCompactor({
      strategy: strat,
      triggerFraction: 0.6,
      targetFraction: 0.4,
      maxPasses: 1,
      toolTruncation: false,
    })
    const budget = c.budget(fakeProvider(), 'openai/gpt-4o-mini')
    const messages = [
      textMsg('user', 'a'),
      textMsg('assistant', 'b'),
      textMsg('user', 'c'),
      textMsg('assistant', 'd'),
    ]
    const events: CompactionEvent[] = []
    c.on('compacted', (e) => events.push(e))
    await c.maybeCompact(
      session(budget.triggerAt + 100, messages),
      fakeProvider(),
      'openai/gpt-4o-mini',
    )
    expect(events.length).toBe(1)
    expect(events[0]!.step).toBe('summarized')
  })

  it('rolls over as the LAST resort, not the first response', async () => {
    // Strategy that returns null (signal "give up"). With truncation off, this
    // should escalate directly to rollover — but rollover is still emitted
    // LAST, after the strategy was given a chance.
    const strat: CompactionStrategy = {
      descriptorId: 'noop',
      canCompact: () => false,
      compact: async () => null,
    }
    const c = new RollingCompactor({
      strategy: strat,
      triggerFraction: 0.6,
      targetFraction: 0.4,
      maxPasses: 1,
      toolTruncation: false,
      summaryModel: 'openai/gpt-4o-mini',
    })
    const budget = c.budget(fakeProvider(), 'openai/gpt-4o-mini')
    const events: CompactionEvent[] = []
    let rolloverFired = false
    c.on('compacted', (e) => events.push(e))
    c.on('session-rollover', () => {
      rolloverFired = true
    })
    await c.maybeCompact(
      session(budget.triggerAt + 100, [textMsg('user', 'a'), textMsg('assistant', 'b')]),
      fakeProvider({ summaryDelta: 'rolled-over summary' }),
      'openai/gpt-4o-mini',
    )
    expect(rolloverFired).toBe(true)
    // No `compacted` events should have fired since the strategy gave up.
    expect(events.length).toBe(0)
  })
})

describe('RollingCompactor — config validation', () => {
  it('rejects invalid triggerFraction', () => {
    expect(() => new RollingCompactor({ triggerFraction: 0 })).toThrow()
    expect(() => new RollingCompactor({ triggerFraction: 1.5 })).toThrow()
  })
  it('rejects targetFraction >= triggerFraction', () => {
    expect(
      () => new RollingCompactor({ triggerFraction: 0.5, targetFraction: 0.6 }),
    ).toThrow()
  })
})
