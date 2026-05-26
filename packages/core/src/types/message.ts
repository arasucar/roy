import type { ToolCall, ToolResult } from './tool.js'

// ─── Roles ────────────────────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system' | 'tool'

// ─── Message content blocks ───────────────────────────────────────────────────

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolCallContent {
  type: 'tool_call'
  toolCall: ToolCall
}

export interface ToolResultContent {
  type: 'tool_result'
  toolResult: ToolResult
}

export interface SummaryContent {
  /** Injected by the compaction system — marks this as a rolled-up summary block */
  type: 'summary'
  text: string
  /** How many original messages this summary replaced */
  replacedCount: number
  /** Token count of the content before compaction */
  originalTokens: number
  /** Message IDs represented by this summary, when available. */
  sourceMessageIds?: string[]
}

export type ContentBlock = TextContent | ToolCallContent | ToolResultContent | SummaryContent

// ─── Cost snapshot ────────────────────────────────────────────────────────────

export interface CostSnapshot {
  /** Tokens consumed by the prompt (input) for this turn */
  promptTokens: number
  /** Tokens generated in the response (output) for this turn */
  completionTokens: number
  /** Estimated USD cost for this turn */
  estimatedCostUsd: number
  /** Anthropic-only: tokens written to prompt cache this turn. */
  cacheCreationInputTokens?: number
  /** Anthropic-only: tokens read from prompt cache this turn. */
  cacheReadInputTokens?: number
}

// ─── Core message type ────────────────────────────────────────────────────────

/**
 * A single message in a Roy conversation.
 *
 * @typeParam TInput  - Shape of the user-facing input (defaults to unknown)
 * @typeParam TOutput - Shape of the assistant-facing output (defaults to unknown)
 *
 * @example
 * ```ts
 * type MyMessage = Message<{ query: string }, { answer: string; citations: string[] }>
 * ```
 */
export interface Message<TInput = unknown, TOutput = unknown> {
  id: string
  role: Role
  content: ContentBlock[]
  /** Raw typed input — set on user turns */
  input?: TInput
  /** Raw typed output — set on assistant turns after parsing */
  output?: TOutput
  /** Which agent produced this message (undefined on user turns) */
  agentId?: string
  /** ISO timestamp */
  createdAt: string
  /** Cost snapshot — populated after the turn completes */
  cost?: CostSnapshot
  /** Arbitrary key/value metadata the host app can attach */
  metadata?: Record<string, unknown>
}

// ─── Streaming chunk ─────────────────────────────────────────────────────────

export interface TextChunk {
  type: 'text'
  delta: string
}

export interface ToolCallChunk {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  /** Partial JSON string of tool arguments */
  argumentsDelta: string
}

export interface ToolResultChunk {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  result: unknown
  isError?: boolean
}

export interface UsageChunk {
  type: 'usage'
  promptTokens: number
  completionTokens: number
  /**
   * Anthropic-only: tokens written to the prompt cache this turn (~25% premium
   * vs regular input). Surfaced so CostCalculator can attribute the cost.
   */
  cacheCreationInputTokens?: number
  /**
   * Anthropic-only: tokens read from the prompt cache this turn (~90% discount
   * vs regular input). Surfaced so CostCalculator can attribute the discount.
   */
  cacheReadInputTokens?: number
}

export interface ErrorChunk {
  type: 'error'
  error: Error
}

export interface DoneChunk {
  type: 'done'
  message: Message
  /**
   * All assistant/tool messages produced internally during this turn.
   * Usually this is just [message], but tool loops include intermediate
   * assistant tool-call messages and tool-result messages before the final
   * assistant answer.
   */
  messages?: Message[]
}

export type StreamChunk =
  | TextChunk
  | ToolCallChunk
  | ToolResultChunk
  | UsageChunk
  | ErrorChunk
  | DoneChunk
