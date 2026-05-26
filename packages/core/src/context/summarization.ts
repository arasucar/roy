import type { CompactionStrategy, CompactionContext, CompactionResult } from './types.js'
import type { Message, SummaryContent } from '../types/message.js'
import type { LLMProvider } from '../providers/types.js'
import { generateId } from '../utils/id.js'

const DEFAULT_SUMMARY_PROMPT = `You are a precise and thorough conversation summarizer.

Your task is to compress the following conversation excerpt into a concise summary that preserves:
- All key decisions made
- All facts, figures, and specific details mentioned
- All action items or next steps
- User preferences or constraints stated
- Any important context that would affect future responses

Do NOT add any information not present in the input.
Do NOT include meta-commentary about the summarization process.
Output ONLY the summary — no preamble, no headers.

Conversation to summarize:
{{messages}}`

export interface SummarizationConfig {
  /**
   * The LLM provider to use for generating summaries.
   * Defaults to the session's primary provider.
   */
  provider?: LLMProvider | undefined
  /** Model ID to use for summarization. Recommend a fast, cheap model. */
  model?: string | undefined
  /**
   * Custom summarization prompt. Use {{messages}} as the placeholder.
   */
  summaryPrompt?: string | undefined
  /**
   * How many messages (from the oldest) to summarize per pass.
   * Default: compact the oldest 50% of non-system messages.
   */
  batchRatio?: number | undefined
  /**
   * Minimum messages required before attempting summarization.
   * Default: 4
   */
  minMessages?: number | undefined
}

/**
 * Summarization compaction strategy.
 *
 * On each compaction pass:
 * 1. Takes the oldest `batchRatio` fraction of messages
 * 2. Asks the LLM to summarize them using a configurable prompt
 * 3. Replaces those messages with a single SummaryContent block
 *
 * Memory-marked messages contribute to global memory extraction
 * before being compacted (handled by MemoryExtractor, called by RollingCompactor).
 */
export class SummarizationStrategy implements CompactionStrategy {
  readonly descriptorId = 'summarization'

  private readonly summaryPrompt: string
  private readonly batchRatio: number
  private readonly minMessages: number
  private provider: LLMProvider | undefined
  private model: string | undefined

  constructor(config: SummarizationConfig = {}) {
    this.summaryPrompt = config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT
    this.batchRatio = config.batchRatio ?? 0.5
    this.minMessages = config.minMessages ?? 4
    this.provider = config.provider
    this.model = config.model
  }

  canCompact(messages: Message[], _context: CompactionContext): boolean {
    const compactable = messages.filter(
      (m) => m.role !== 'system' && !m.content.some((b) => b.type === 'summary'),
    )
    return compactable.length >= this.minMessages
  }

  async compact(messages: Message[], context: CompactionContext): Promise<CompactionResult | null> {
    if (!this.canCompact(messages, context)) return null

    const provider = this.provider
    if (!provider) {
      throw new Error('[Roy] SummarizationStrategy requires a provider. Pass provider in config.')
    }

    // Split: system/summary blocks (always kept) vs compactable messages
    const kept: Message[] = messages.filter(
      (m) => m.role === 'system' || m.content.some((b) => b.type === 'summary'),
    )
    const compactable = messages.filter(
      (m) => m.role !== 'system' && !m.content.some((b) => b.type === 'summary'),
    )

    const batchSize = Math.max(2, Math.floor(compactable.length * this.batchRatio))
    const toSummarize = compactable.slice(0, batchSize)
    const remaining = compactable.slice(batchSize)

    // Serialize messages for the summary prompt
    const serialized = toSummarize
      .map((m) => {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as any).text)
          .join('\n')
        return `[${m.role}${m.agentId ? ` (${m.agentId})` : ''}]: ${text}`
      })
      .join('\n\n')

    const prompt = this.summaryPrompt.replace('{{messages}}', serialized)

    // Estimate original tokens
    const originalTokens = Math.ceil(serialized.length / 4)

    if (!this.model) {
      throw new Error(
        '[Roy] SummarizationStrategy requires a model. Set compaction.summaryModel in your AgentDefinition, ' +
          'or pass model in SummarizationConfig. Use a fast, cheap model (e.g. "gpt-4o-mini" for OpenAI or "openai/gpt-4o-mini" for OpenRouter).',
      )
    }

    // Call the LLM for the summary
    let summaryText = ''
    for await (const chunk of provider.stream({
      model: this.model,
      messages: [
        {
          id: generateId(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          createdAt: new Date().toISOString(),
        },
      ],
    })) {
      if (chunk.type === 'text') summaryText += chunk.delta
      if (chunk.type === 'error') throw chunk.error
    }

    const summaryBlock: SummaryContent = {
      type: 'summary',
      text: summaryText.trim(),
      replacedCount: toSummarize.length,
      originalTokens,
    }

    const summaryMessage: Message = {
      id: generateId(),
      role: 'system',
      content: [summaryBlock],
      createdAt: new Date().toISOString(),
    }

    const resultMessages = [...kept, summaryMessage, ...remaining]
    const newTokens = Math.ceil(summaryText.length / 4)
    const tokensFreed = originalTokens - newTokens

    return {
      messages: resultMessages,
      tokensFreed: Math.max(0, tokensFreed),
      summary: `Summarized ${toSummarize.length} messages → ~${newTokens} tokens (freed ~${tokensFreed}).`,
    }
  }
}
