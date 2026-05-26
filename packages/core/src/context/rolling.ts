import EventEmitter from 'eventemitter3'
import type { CompactionStrategy, CompactionContext } from './types.js'
import type { ChatSession } from '../types/session.js'
import type { Message } from '../types/message.js'
import type { LLMProvider } from '../providers/types.js'
import { SummarizationStrategy } from './summarization.js'
import { ToolOutputTruncationStrategy } from './truncate.js'
import type { ToolOutputTruncateConfig } from './truncate.js'
import { generateId } from '../utils/id.js'

export interface RollingCompactorConfig {
  /**
   * Trigger compaction when `session.cumulativeTokens` reaches this fraction
   * of the model's usable input budget (= contextWindow − reserveOutputTokens).
   * Default 0.6.
   *
   * Set this OR `watermarkTokens` (legacy). If both are set, `watermarkTokens`
   * wins for backward compatibility.
   */
  triggerFraction?: number | undefined
  /**
   * After compaction runs, try to bring usage below this fraction of the
   * usable input budget. Default 0.4. Must be < triggerFraction.
   */
  targetFraction?: number | undefined
  /**
   * Tokens held back from the context window for the next assistant response.
   * The usable input budget is `contextWindow − reserveOutputTokens`. Default 8_192.
   */
  reserveOutputTokens?: number | undefined

  /**
   * LEGACY: flat token watermark. When set, overrides triggerFraction and
   * triggers compaction at a fixed cumulativeTokens threshold regardless of
   * model. Prefer triggerFraction for new code.
   */
  watermarkTokens?: number | undefined

  /** The strategy to use for each summarisation pass. Default: SummarizationStrategy */
  strategy?: CompactionStrategy | undefined
  /**
   * Cheap-first pass: head+tail truncate large tool_result blocks before
   * paying for an LLM summarisation. Set to `false` to disable. Default: enabled
   * with sensible defaults.
   */
  toolTruncation?: ToolOutputTruncateConfig | false

  /** Max summarisation passes before triggering session rollover. Default: 3 */
  maxPasses?: number | undefined
  /** Provider for generating summaries (passed to default SummarizationStrategy) */
  provider?: LLMProvider | undefined
  /** Model for summaries */
  summaryModel?: string | undefined
  /** Custom summary prompt */
  summaryPrompt?: string | undefined
  /** Exact number of oldest messages to summarize per pass. */
  summaryBatchSize?: number | undefined
}

export interface CompactionEvent {
  sessionId: string
  passNumber: number
  tokensBefore: number
  tokensAfter: number
  tokensFreed: number
  messagesCompacted: number
  summary: string
  /** Which step in the escalation produced this event. */
  step: 'truncated-tools' | 'summarized'
}

export interface SessionRolloverEvent {
  oldSessionId: string
  newSessionId: string
  summaryText: string
  reason: 'max_passes_reached' | 'cannot_compact'
}

export type RollingCompactorEvents = {
  compacted: [CompactionEvent]
  'session-rollover': [SessionRolloverEvent]
  error: [Error]
}

/**
 * RollingCompactor — the core compaction engine.
 *
 * Triggers compaction BETWEEN turns (never mid-stream). Watermark is a
 * fraction of the model's usable input budget, not a flat integer — so the
 * same config works across 8k local models and 200k+ frontier models.
 *
 * Escalation order on each `maybeCompact` call:
 *   1. Tool-output truncation (cheap, zero LLM calls). Spares the 2 most
 *      recent tool_result blocks.
 *   2. Summarisation pass via `strategy` (default: SummarizationStrategy on
 *      the oldest 50% of messages).
 *   3. Additional summarisation passes (up to `maxPasses` total) — each pass
 *      summarises the new oldest 50%.
 *   4. Session rollover (last resort) — full session summary into a fresh
 *      session, emitted via `session-rollover`.
 *
 * Each successful step emits a `compacted` event so the host UI can show what
 * happened.
 */
export class RollingCompactor extends EventEmitter<RollingCompactorEvents> {
  private readonly triggerFraction: number
  private readonly targetFraction: number
  private readonly reserveOutputTokens: number
  private readonly legacyWatermark: number | undefined
  private readonly maxPasses: number
  private readonly strategy: CompactionStrategy
  private readonly truncationStrategy: CompactionStrategy | null
  private passCount = 0

  constructor(private readonly config: RollingCompactorConfig = {}) {
    super()
    this.triggerFraction = config.triggerFraction ?? 0.6
    this.targetFraction = config.targetFraction ?? 0.4
    this.reserveOutputTokens = config.reserveOutputTokens ?? 8_192
    this.legacyWatermark = config.watermarkTokens
    this.maxPasses = config.maxPasses ?? 3

    if (!(this.triggerFraction > 0 && this.triggerFraction <= 1)) {
      throw new Error(`[Roy] triggerFraction must be in (0,1], got ${this.triggerFraction}`)
    }
    if (!(this.targetFraction > 0 && this.targetFraction < this.triggerFraction)) {
      throw new Error(
        `[Roy] targetFraction must be in (0, triggerFraction), got ${this.targetFraction}`,
      )
    }

    this.strategy =
      config.strategy ??
      new SummarizationStrategy({
        provider: config.provider,
        model: config.summaryModel,
        summaryPrompt: config.summaryPrompt,
        ...(config.summaryBatchSize !== undefined ? { batchSize: config.summaryBatchSize } : {}),
      })

    this.truncationStrategy =
      config.toolTruncation === false
        ? null
        : new ToolOutputTruncationStrategy(
            typeof config.toolTruncation === 'object' ? config.toolTruncation : {},
          )
  }

  /**
   * Compute the absolute token thresholds for a given model.
   * Exposed for tests + UI ("we'll compact at N tokens, target M").
   */
  budget(
    provider: LLMProvider,
    model: string,
  ): {
    windowSize: number
    inputBudget: number
    triggerAt: number
    targetAt: number
  } {
    const windowSize = provider.contextWindowSize(model)
    const inputBudget = Math.max(1024, windowSize - this.reserveOutputTokens)
    if (this.legacyWatermark !== undefined) {
      return {
        windowSize,
        inputBudget,
        triggerAt: this.legacyWatermark,
        targetAt: Math.floor(this.legacyWatermark * (this.targetFraction / this.triggerFraction)),
      }
    }
    return {
      windowSize,
      inputBudget,
      triggerAt: Math.floor(inputBudget * this.triggerFraction),
      targetAt: Math.floor(inputBudget * this.targetFraction),
    }
  }

  /**
   * Called before each send. Checks if compaction should run and applies it.
   * Returns the updated session (may have fewer messages or be a fresh rollover).
   */
  async maybeCompact(
    session: ChatSession,
    provider: LLMProvider,
    model: string,
  ): Promise<ChatSession> {
    const budget = this.budget(provider, model)
    if (session.cumulativeTokens < budget.triggerAt) return session

    let working = session

    // ── Escalation 1: tool-output truncation ─────────────────────────────────
    if (this.truncationStrategy) {
      const truncated = await this.runStep(
        working,
        provider,
        model,
        this.truncationStrategy,
        'truncated-tools',
      )
      if (truncated) {
        working = truncated
        if (working.cumulativeTokens < budget.targetAt) return working
      }
    }

    // ── Escalation 2..N: summarisation passes ────────────────────────────────
    while (this.passCount < this.maxPasses) {
      const summarised = await this.runStep(working, provider, model, this.strategy, 'summarized')
      if (!summarised) break // strategy can't compact further
      working = summarised
      if (working.cumulativeTokens < budget.targetAt) return working
    }

    // ── Last resort: session rollover ────────────────────────────────────────
    if (working.cumulativeTokens >= budget.targetAt) {
      const reason: SessionRolloverEvent['reason'] =
        this.passCount >= this.maxPasses ? 'max_passes_reached' : 'cannot_compact'
      return this.triggerRollover(working, provider, model, reason)
    }
    return working
  }

  /**
   * Run a single compaction strategy. Returns the new session on success,
   * or null if the strategy returned null (signals "give up, escalate").
   */
  private async runStep(
    session: ChatSession,
    provider: LLMProvider,
    model: string,
    strategy: CompactionStrategy,
    step: CompactionEvent['step'],
  ): Promise<ChatSession | null> {
    const tokensBefore = session.cumulativeTokens
    const context: CompactionContext = {
      session,
      currentTokens: tokensBefore,
      contextWindowSize: provider.contextWindowSize(model),
      passCount: this.passCount,
    }

    const result = await strategy.compact(session.messages, context)
    if (result === null) return null

    if (step === 'summarized') this.passCount++

    const tokensAfter = Math.max(0, tokensBefore - result.tokensFreed)
    const updated: ChatSession = {
      ...session,
      messages: result.messages,
      cumulativeTokens: tokensAfter,
      updatedAt: new Date().toISOString(),
    }

    this.emit('compacted', {
      sessionId: session.id,
      passNumber: this.passCount,
      tokensBefore,
      tokensAfter,
      tokensFreed: result.tokensFreed,
      messagesCompacted: session.messages.length - result.messages.length,
      summary: result.summary,
      step,
    })

    return updated
  }

  /**
   * Trigger a session rollover:
   * 1. Summarize the entire current session
   * 2. Create a new session with the summary as the first system message
   * 3. Emit the session-rollover event so the host can update UI / persist
   */
  private async triggerRollover(
    session: ChatSession,
    provider: LLMProvider,
    model: string,
    reason: SessionRolloverEvent['reason'],
  ): Promise<ChatSession> {
    // Generate a full summary of the current session
    const allText = session.messages
      .filter((m) => m.role !== 'system' || m.content.some((b) => b.type === 'summary'))
      .map((m) => {
        const text = m.content
          .filter((b) => b.type === 'text' || b.type === 'summary')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')
        return `[${m.role}]: ${text}`
      })
      .join('\n\n')

    const rolloverPrompt = `Create a comprehensive summary of this conversation that captures all important context, decisions, preferences, and information needed to continue the conversation seamlessly in a new session.\n\nConversation:\n${allText}`

    let summaryText = ''
    for await (const chunk of provider.stream({
      model: this.config.summaryModel ?? model,
      messages: [
        {
          id: generateId(),
          role: 'user',
          content: [{ type: 'text', text: rolloverPrompt }],
          createdAt: new Date().toISOString(),
        },
      ],
    })) {
      if (chunk.type === 'text') summaryText += chunk.delta
    }

    const newSessionId = generateId()

    const summaryMessage: Message = {
      id: generateId(),
      role: 'system',
      content: [
        {
          type: 'summary',
          text: `[Context from previous session]\n\n${summaryText.trim()}`,
          replacedCount: session.messages.length,
          originalTokens: session.cumulativeTokens,
        },
      ],
      createdAt: new Date().toISOString(),
    }

    const newSession: ChatSession = {
      ...session,
      id: newSessionId,
      messages: [summaryMessage],
      cumulativeTokens: Math.ceil(summaryText.length / 4),
      cumulativeCostUsd: 0,
      parentSessionId: session.id,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.emit('session-rollover', {
      oldSessionId: session.id,
      newSessionId,
      summaryText: summaryText.trim(),
      reason,
    })

    this.passCount = 0
    return newSession
  }
}
