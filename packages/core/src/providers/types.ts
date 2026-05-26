import type { Message, StreamChunk } from '../types/message.js'
import type { ToolDefinition } from '../types/tool.js'

// ─── Unified provider interface ───────────────────────────────────────────────

export interface SendOptions {
  model: string
  systemPrompt?: string | undefined
  messages: Message[]
  tools?: ToolDefinition[] | undefined
  temperature?: number | undefined
  maxTokens?: number | undefined
  /** AbortSignal for cancellation */
  signal?: AbortSignal | undefined
}

/**
 * All provider adapters implement this interface.
 * Roy communicates with every LLM through this contract.
 */
export interface LLMProvider {
  readonly type: string

  /**
   * Send a message and stream back chunks.
   * The final chunk is always `{ type: 'done', message }`.
   */
  stream(options: SendOptions): AsyncIterable<StreamChunk>

  /**
   * Estimate the token count for a list of messages without making an API call.
   * Implementations may use a heuristic (chars/4) if no tokenizer is available.
   */
  estimateTokens(messages: Message[], systemPrompt?: string): number

  /**
   * Return the max context window size for a given model in tokens.
   */
  contextWindowSize(model: string): number
}
