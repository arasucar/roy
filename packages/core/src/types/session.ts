import type { Message } from './message.js'
import type { CompactionStrategyDescriptor } from '../context/types.js'

// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'rolled_over' | 'archived'

/**
 * A fully serializable chat session.
 * Functions (tools, strategies) are stored as descriptor IDs — see ToolRegistry
 * and CompactionStrategyRegistry to resolve them back on load.
 *
 * @typeParam TInput  - Typed user input shape for this session
 * @typeParam TOutput - Typed assistant output shape for this session
 */
export interface ChatSession<TInput = unknown, TOutput = unknown> {
  id: string
  /** Human-readable label */
  label?: string
  /** The agent driving this session */
  agentId: string
  status: SessionStatus
  messages: Message<TInput, TOutput>[]

  /** Running total of tokens processed (used to trigger compaction watermarks) */
  cumulativeTokens: number
  /** Running estimated cost in USD */
  cumulativeCostUsd: number

  /** Which compaction strategy is active — stored as a descriptor for serialization */
  compactionStrategy?: CompactionStrategyDescriptor

  /**
   * If this session was created by a rollover, this points to the parent session.
   * The first message in `messages` will be a summary of the parent.
   */
  parentSessionId?: string
  /**
   * If this session has been rolled over, this points to the child session.
   */
  childSessionId?: string

  /** ISO timestamp */
  createdAt: string
  updatedAt: string

  /** Arbitrary host-app metadata */
  metadata?: Record<string, unknown>
}

// ─── Session branch ───────────────────────────────────────────────────────────

export interface BranchOptions {
  /** Message ID to branch from (inclusive). Defaults to last message. */
  fromMessageId?: string
  label?: string
  metadata?: Record<string, unknown>
}

// ─── Storage adapter ─────────────────────────────────────────────────────────

/**
 * Implement this interface to plug in any persistence backend
 * (Redis, SQLite, Supabase, DynamoDB, etc.)
 */
export interface StorageAdapter<TInput = unknown, TOutput = unknown> {
  save(session: ChatSession<TInput, TOutput>): Promise<void>
  load(sessionId: string): Promise<ChatSession<TInput, TOutput> | undefined>
  list(agentId?: string): Promise<ChatSession<TInput, TOutput>[]>
  delete(sessionId: string): Promise<void>
}
