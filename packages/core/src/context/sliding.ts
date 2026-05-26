import type { CompactionStrategy, CompactionContext, CompactionResult } from './types.js'
import type { Message } from '../types/message.js'

export interface SlidingWindowConfig {
  /** Number of most-recent messages to keep. Default: 20 */
  keepLastN?: number
  /** Always preserve system messages and summary blocks. Default: true */
  preserveSystem?: boolean
}

/**
 * Simplest compaction strategy — drops the oldest N messages.
 * Zero LLM calls, zero cost, zero latency.
 * Best for stateless tools or when speed matters more than context continuity.
 */
export class SlidingWindowStrategy implements CompactionStrategy {
  readonly descriptorId = 'sliding-window'

  private readonly keepLastN: number
  private readonly preserveSystem: boolean

  constructor(config: SlidingWindowConfig = {}) {
    this.keepLastN = config.keepLastN ?? 20
    this.preserveSystem = config.preserveSystem ?? true
  }

  canCompact(messages: Message[], _context: CompactionContext): boolean {
    return messages.length > this.keepLastN
  }

  async compact(
    messages: Message[],
    _context: CompactionContext,
  ): Promise<CompactionResult | null> {
    if (!this.canCompact(messages, _context)) return null

    const systemMessages = this.preserveSystem
      ? messages.filter((m) => m.role === 'system' || m.content.some((b) => b.type === 'summary'))
      : []

    const nonSystem = messages.filter(
      (m) => m.role !== 'system' && !m.content.some((b) => b.type === 'summary'),
    )

    const kept = nonSystem.slice(-this.keepLastN)
    const dropped = nonSystem.length - kept.length
    const result = [...systemMessages, ...kept]

    return {
      messages: result,
      tokensFreed: Math.ceil(
        dropped *
          (messages.reduce(
            (sum, m) =>
              sum +
              m.content
                .map((b) => ('text' in b ? (b as any).text.length : 0))
                .reduce((a, b) => a + b, 0),
            0,
          ) /
            messages.length /
            4),
      ),
      summary: `SlidingWindow: dropped ${dropped} oldest messages, kept last ${kept.length}.`,
    }
  }
}
