import type { Message } from '../types/message.js'
import type { ChatSession } from '../types/session.js'

// ─── Compaction strategy ──────────────────────────────────────────────────────

export interface CompactionContext {
  session: ChatSession
  /** Current estimated token count */
  currentTokens: number
  /** The provider's context window size */
  contextWindowSize: number
  /** How many compaction passes have already run on this session */
  passCount: number
}

export interface CompactionResult {
  /** Updated message list after compaction */
  messages: Message[]
  /** Tokens freed by this compaction pass */
  tokensFreed: number
  /** Human-readable description of what happened */
  summary: string
}

/**
 * All compaction strategies implement this interface.
 * Strategies are called by the RollingCompactor when the watermark is hit.
 */
export interface CompactionStrategy {
  /**
   * Descriptor ID — used for serialization so the session can be restored
   * with the same strategy loaded from the registry.
   */
  readonly descriptorId: string

  /**
   * Perform one compaction pass.
   * Must return a smaller message list — if it cannot, return null to signal
   * that compaction is impossible and a session rollover is needed.
   */
  compact(
    messages: Message[],
    context: CompactionContext,
  ): Promise<CompactionResult | null>

  /**
   * Estimate whether compaction is possible given the current state.
   * Implementations should return false if the message list is already
   * too small to meaningfully reduce.
   */
  canCompact(messages: Message[], context: CompactionContext): boolean
}

// ─── Descriptor (for serialization) ──────────────────────────────────────────

export interface CompactionStrategyDescriptor {
  descriptorId: string
  config?: Record<string, unknown>
}

// ─── Strategy registry ────────────────────────────────────────────────────────

export class CompactionStrategyRegistry {
  private strategies = new Map<string, CompactionStrategy>()

  register(strategy: CompactionStrategy): this {
    this.strategies.set(strategy.descriptorId, strategy)
    return this
  }

  get(descriptorId: string): CompactionStrategy | undefined {
    return this.strategies.get(descriptorId)
  }
}

export const defaultStrategyRegistry = new CompactionStrategyRegistry()
