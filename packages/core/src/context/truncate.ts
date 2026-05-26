import type { CompactionStrategy, CompactionContext, CompactionResult } from './types.js'
import type { Message, ContentBlock } from '../types/message.js'

export interface ToolOutputTruncateConfig {
  /**
   * Tool results longer than this many characters are candidates for
   * truncation. Default 4_000.
   */
  maxToolOutputChars?: number
  /** Characters kept from the start of a truncated block. Default 1_500. */
  headChars?: number
  /** Characters kept from the end of a truncated block. Default 500. */
  tailChars?: number
  /**
   * The N most-recent tool_result blocks are preserved verbatim — they're
   * the ones most likely to be referenced by the next turn. Default 2.
   */
  keepRecentToolResults?: number
}

/**
 * Cheap-first compaction: head+tail truncates large tool_result blocks before
 * the rolling compactor falls back to an LLM-based summarisation pass. Zero
 * model calls, zero cost, often resolves context pressure on its own in
 * tool-heavy agent loops.
 *
 * Use this as a cheap first pass inside the RollingCompactor's escalation
 * sequence — NOT as the only compaction strategy. It can't help with chatter
 * that's already plain text.
 */
export class ToolOutputTruncationStrategy implements CompactionStrategy {
  readonly descriptorId = 'tool-output-truncation'

  private readonly max: number
  private readonly head: number
  private readonly tail: number
  private readonly keepRecent: number

  constructor(config: ToolOutputTruncateConfig = {}) {
    this.max = config.maxToolOutputChars ?? 4_000
    this.head = config.headChars ?? 1_500
    this.tail = config.tailChars ?? 500
    this.keepRecent = config.keepRecentToolResults ?? 2
  }

  canCompact(messages: Message[], _context: CompactionContext): boolean {
    // Worth trying if any tool_result block is over the threshold.
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && extractToolResultText(b).length > this.max) {
          return true
        }
      }
    }
    return false
  }

  async compact(
    messages: Message[],
    _context: CompactionContext,
  ): Promise<CompactionResult | null> {
    // Find all tool_result positions in original order.
    const positions: Array<{ msgIdx: number; blockIdx: number }> = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]!
        if (block.type === 'tool_result') {
          positions.push({ msgIdx: i, blockIdx: j })
        }
      }
    }

    // Spare the N most-recent.
    const truncatable = positions.slice(0, Math.max(0, positions.length - this.keepRecent))
    if (truncatable.length === 0) return null

    // Clone messages so we don't mutate the caller's data.
    const cloned: Message[] = messages.map((m) => ({
      ...m,
      content: m.content.map((b) => ({ ...b }) as ContentBlock),
    }))

    let truncatedBlocks = 0
    let charsRemoved = 0
    const truncatedMessageIndexes = new Set<number>()

    for (const { msgIdx, blockIdx } of truncatable) {
      const msg = cloned[msgIdx]!
      const block = msg.content[blockIdx]
      if (!block || block.type !== 'tool_result') continue
      const text = extractToolResultText(block)
      if (text.length <= this.max) continue

      const removed = text.length - (this.head + this.tail)
      if (removed <= 0) continue

      const replacement =
        text.slice(0, this.head) +
        `\n…[truncated ${removed.toLocaleString()} chars from tool output]…\n` +
        text.slice(text.length - this.tail)

      writeToolResultText(block, replacement)
      truncatedBlocks++
      charsRemoved += removed
      truncatedMessageIndexes.add(msgIdx)
    }

    if (truncatedBlocks === 0) return null

    return {
      messages: cloned,
      tokensFreed: Math.ceil(charsRemoved / 4),
      summary: `ToolOutputTruncation: truncated ${truncatedBlocks} tool_result block(s), freed ~${Math.ceil(
        charsRemoved / 4,
      ).toLocaleString()} tokens.`,
      compactedMessages: [...truncatedMessageIndexes].map((idx) => messages[idx]!),
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function extractToolResultText(block: ContentBlock): string {
  if (block.type !== 'tool_result') return ''
  const result = block.toolResult.result
  if (typeof result === 'string') return result
  // Best-effort stringify if the host stored a non-string result.
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function writeToolResultText(block: ContentBlock, text: string): void {
  if (block.type !== 'tool_result') return
  block.toolResult = { ...block.toolResult, result: text }
}
