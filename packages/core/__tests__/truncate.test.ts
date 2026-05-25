import { describe, it, expect } from 'vitest'
import { ToolOutputTruncationStrategy } from '../src/context/truncate.js'
import type { Message } from '../src/types/message.js'
import type { CompactionContext } from '../src/context/types.js'

function toolResultMsg(id: string, text: string): Message {
  return {
    id,
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolResult: {
          toolCallId: `tc_${id}`,
          name: 'search',
          result: text,
        },
      },
    ],
    createdAt: '2026-05-26T00:00:00Z',
  }
}

function ctx(messages: Message[]): CompactionContext {
  return {
    session: {
      id: 's',
      agentId: 'a',
      status: 'active',
      messages,
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      createdAt: '',
      updatedAt: '',
    },
    currentTokens: 0,
    contextWindowSize: 200_000,
    passCount: 0,
  }
}

describe('ToolOutputTruncationStrategy', () => {
  it('returns null when no tool_result blocks exceed the threshold', async () => {
    const s = new ToolOutputTruncationStrategy({ maxToolOutputChars: 10_000 })
    const messages = [toolResultMsg('a', 'short')]
    const result = await s.compact(messages, ctx(messages))
    expect(result).toBeNull()
  })

  it('truncates older tool_results, spares the most recent two by default', async () => {
    const s = new ToolOutputTruncationStrategy({
      maxToolOutputChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const big = 'L'.repeat(5_000)
    const messages = [
      toolResultMsg('1', big),
      toolResultMsg('2', big),
      toolResultMsg('3', big),
      toolResultMsg('4', big), // last two should be spared
      toolResultMsg('5', big),
    ]
    const result = await s.compact(messages, ctx(messages))
    expect(result).not.toBeNull()
    const r = result!

    const text = (i: number) =>
      (r.messages[i]!.content[0] as { toolResult: { result: string } }).toolResult.result

    // First three are truncated
    expect(text(0).length).toBeLessThan(500)
    expect(text(1).length).toBeLessThan(500)
    expect(text(2).length).toBeLessThan(500)
    expect(text(0)).toContain('[truncated')

    // Last two are intact
    expect(text(3)).toBe(big)
    expect(text(4)).toBe(big)

    expect(r.tokensFreed).toBeGreaterThan(0)
  })

  it('does not mutate the original messages array', async () => {
    const s = new ToolOutputTruncationStrategy({ maxToolOutputChars: 100, keepRecentToolResults: 0 })
    const original = 'L'.repeat(5_000)
    const messages = [toolResultMsg('1', original)]
    await s.compact(messages, ctx(messages))
    const stillBig = (messages[0]!.content[0] as { toolResult: { result: string } }).toolResult.result
    expect(stillBig).toBe(original) // input untouched
  })

  it('canCompact mirrors the threshold', () => {
    const s = new ToolOutputTruncationStrategy({ maxToolOutputChars: 1_000 })
    expect(s.canCompact([toolResultMsg('a', 'L'.repeat(100))], ctx([]))).toBe(false)
    expect(s.canCompact([toolResultMsg('a', 'L'.repeat(5_000))], ctx([]))).toBe(true)
  })
})
