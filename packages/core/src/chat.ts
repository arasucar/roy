import EventEmitter from 'eventemitter3'
import type { AgentDefinition } from './types/agent.js'
import type { Message, StreamChunk } from './types/message.js'
import type { ChatSession, StorageAdapter } from './types/session.js'
import type { MemoryConfig } from './types/memory.js'
import type { CompactionEvent, SessionRolloverEvent } from './context/rolling.js'
import { AgentRegistry } from './agents/registry.js'
import { Orchestrator } from './agents/orchestrator.js'
import { SessionManager } from './session/manager.js'
import { MemoryStore } from './session/stores/memory-store.js'
import { RollingCompactor } from './context/rolling.js'
import { MemoryExtractor, InMemoryMemoryStore } from './context/memory-extractor.js'
import { CostCalculator } from './cost/calculator.js'
import type { CostCalculatorConfig } from './cost/calculator.js'
import { generateId } from './utils/id.js'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface RoyConfig {
  /**
   * All agent definitions. At least one is required.
   * Roy does not create implicit agents — all must be explicitly defined.
   */
  agents: AgentDefinition[]

  /**
   * Default agent ID to use when no agent is specified.
   * Defaults to the first agent in the list.
   */
  defaultAgentId?: string

  /**
   * Session storage adapter.
   * Defaults to MemoryStore (in-process, no persistence).
   */
  store?: StorageAdapter

  /**
   * Global memory configuration.
   * When provided, important information survives compaction and session rollovers.
   */
  memory?: MemoryConfig

  /**
   * Cost calculator configuration.
   * Use pricingOverrides to handle enterprise pricing or new models.
   */
  cost?: CostCalculatorConfig
}

// ─── Send options ─────────────────────────────────────────────────────────────

export interface SendOptions<TInput = string> {
  /** Message content */
  input: TInput
  /** Override the agent for this message only */
  agentId?: string
  /** Session to continue. If not provided, creates a new session. */
  sessionId?: string
  /** AbortSignal for cancellation */
  signal?: AbortSignal
  /** Arbitrary metadata to attach to the user message */
  metadata?: Record<string, unknown>
  /** Mark this message for memory extraction */
  memoryMarker?: import('./types/memory.js').MemoryMarker
}

// ─── Roy instance events ──────────────────────────────────────────────────────

export interface RoyEvents {
  compacted: [CompactionEvent]
  'session-rollover': [SessionRolloverEvent]
  'agent-handoff': [{ from: string; to: string; hopNumber: number }]
  'plan-ready': [{ plan: import('./types/agent.js').PlanDocument }]
  'plan-approved': [{ plan: import('./types/agent.js').PlanDocument }]
  'plan-rejected': [{ plan: import('./types/agent.js').PlanDocument }]
  error: [Error]
}

// ─── Roy instance ─────────────────────────────────────────────────────────────

export class Roy extends EventEmitter<RoyEvents> {
  readonly registry: AgentRegistry
  readonly sessions: SessionManager
  private readonly orchestrator: Orchestrator
  private readonly costCalc: CostCalculator
  private readonly defaultAgentId: string
  private memoryExtractor?: MemoryExtractor
  private compactors = new Map<string, RollingCompactor>()

  constructor(private readonly config: RoyConfig) {
    super()

    if (!config.agents.length) {
      throw new Error('[Roy] At least one AgentDefinition is required.')
    }

    this.registry = new AgentRegistry(config.agents)
    this.defaultAgentId = config.defaultAgentId ?? config.agents[0]!.id
    this.sessions = new SessionManager(config.store ?? new MemoryStore())
    this.orchestrator = new Orchestrator(this.registry, config.cost)
    this.costCalc = new CostCalculator(config.cost)

    // Forward orchestrator events
    this.orchestrator.on('agent-handoff', (e) => this.emit('agent-handoff', e))
    this.orchestrator.on('plan-ready', (e) => this.emit('plan-ready', e))
    this.orchestrator.on('plan-approved', (e) => this.emit('plan-approved', e))
    this.orchestrator.on('plan-rejected', (e) => this.emit('plan-rejected', e))

    // Set up global memory if configured
    if (config.memory) {
      const store = config.memory.store ?? new InMemoryMemoryStore()
      const defaultAgent = this.registry.get(this.defaultAgentId)
      const provider = this.orchestrator.getProvider(defaultAgent)
      this.memoryExtractor = new MemoryExtractor(
        config.memory.schema,
        store,
        provider,
        defaultAgent.model,
      )
    }
  }

  // ─── Core send method ───────────────────────────────────────────────────────

  /**
   * Send a message and stream back chunks.
   *
   * @example
   * ```ts
   * for await (const chunk of roy.send({ input: 'Hello!' })) {
   *   if (chunk.type === 'text') process.stdout.write(chunk.delta)
   *   if (chunk.type === 'done') console.log('\nCost:', chunk.message.cost)
   * }
   * ```
   */
  async *send<TInput = string>(
    options: SendOptions<TInput>,
  ): AsyncIterable<StreamChunk> {
    const agentId = options.agentId ?? this.defaultAgentId
    const agent = this.registry.get(agentId)
    const provider = this.orchestrator.getProvider(agent)

    // Load or create session
    let session: ChatSession
    if (options.sessionId) {
      const existing = await this.sessions.load(options.sessionId)
      if (!existing) throw new Error(`[Roy] Session "${options.sessionId}" not found.`)
      session = existing
    } else {
      session = await this.sessions.create({ agentId })
    }

    // Inject global memory into system prompt if configured
    let effectiveSystemPrompt = agent.systemPrompt
    if (this.memoryExtractor && this.config.memory?.injectIntoSystemPrompt !== false) {
      const memoryContext = await this.memoryExtractor.formatForSystemPrompt(
        this.config.memory?.systemPromptTemplate,
      )
      if (memoryContext) {
        effectiveSystemPrompt = `${agent.systemPrompt}\n\n${memoryContext}`
      }
    }

    // Get or create the compactor for this session
    let compactor = this.compactors.get(session.id)
    if (!compactor) {
      const compactionConfig = agent.compaction ?? {}
      compactor = new RollingCompactor({
        // Pass watermarkTokens through ONLY if the agent set it explicitly —
        // otherwise the new % watermark (triggerFraction/targetFraction)
        // computes a model-aware budget. Defaulting to a flat 20k would
        // either waste 90% of a 200k Sonnet window or OOM an 8k local model.
        ...(compactionConfig.watermarkTokens !== undefined
          ? { watermarkTokens: compactionConfig.watermarkTokens }
          : {}),
        ...(compactionConfig.maxCompactionPasses !== undefined
          ? { maxPasses: compactionConfig.maxCompactionPasses }
          : {}),
        ...(compactionConfig.summaryPrompt !== undefined
          ? { summaryPrompt: compactionConfig.summaryPrompt }
          : {}),
        provider,
        summaryModel: agent.model,
      })

      compactor.on('compacted', (e) => this.emit('compacted', e))
      compactor.on('session-rollover', async (e) => {
        await this.sessions.markRolledOver(session, e.newSessionId)
        // Extract memory from the old session before it's gone (if configured)
        if (this.memoryExtractor) {
          const markedMessages = session.messages.filter((m) => m.metadata?.['memoryMarker'])
          if (markedMessages.length > 0) {
            await this.memoryExtractor.extractFromMessages(markedMessages, session.id)
          }
        }
        // Clean up the old compactor — the new session will get a fresh one on next send
        this.compactors.delete(session.id)
        this.emit('session-rollover', e)
      })

      this.compactors.set(session.id, compactor)
    }

    // PRE-COMPACTION: check watermark before sending
    session = await compactor.maybeCompact(session, provider, agent.model)

    // Build user message
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: [
        {
          type: 'text',
          text: typeof options.input === 'string'
            ? options.input
            : JSON.stringify(options.input),
        },
      ],
      input: options.input,
      createdAt: new Date().toISOString(),
      metadata: {
        ...options.metadata,
        ...(options.memoryMarker ? { memoryMarker: options.memoryMarker } : {}),
      },
    }

    // Extract memory from messages about to be compacted (if memory extractor set up)
    if (this.memoryExtractor && options.memoryMarker) {
      await this.memoryExtractor.extractFromMessages([userMessage], session.id)
    }

    // Run the agent turn
    let finalMessage: Message | undefined
    let promptTokens = 0
    let completionTokens = 0
    let cacheCreationInputTokens = 0
    let cacheReadInputTokens = 0

    for await (const chunk of this.orchestrator.runTurn(
      { ...agent, systemPrompt: effectiveSystemPrompt },
      session,
      userMessage,
      options.signal !== undefined ? { signal: options.signal } : {},
    )) {
      if (chunk.type === 'usage') {
        promptTokens = chunk.promptTokens
        completionTokens = chunk.completionTokens
        cacheCreationInputTokens = chunk.cacheCreationInputTokens ?? 0
        cacheReadInputTokens = chunk.cacheReadInputTokens ?? 0
      }
      if (chunk.type === 'done') {
        const turnCost = this.costCalc.calculate(agent.model, {
          promptTokens,
          completionTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
        })
        finalMessage = {
          ...chunk.message,
          agentId,
          cost: {
            promptTokens: turnCost.promptTokens,
            completionTokens: turnCost.completionTokens,
            estimatedCostUsd: turnCost.estimatedCostUsd,
            cacheCreationInputTokens: turnCost.cacheCreationInputTokens,
            cacheReadInputTokens: turnCost.cacheReadInputTokens,
          },
        }
        // Save messages
        session = await this.sessions.appendMessage(session, userMessage)
        session = await this.sessions.appendMessage(session, finalMessage)

        yield { ...chunk, message: finalMessage }
        continue
      }
      yield chunk
    }

    // Guard: if stream ended without a done chunk (provider error or abort),
    // still persist the user message so the session isn't left in a broken state.
    if (!finalMessage && !options.signal?.aborted) {
      const err = new Error('[Roy] Stream ended without a done chunk — provider may have errored.')
      this.emit('error', err)
      // Still save the user message — the assistant turn is simply absent
      await this.sessions.appendMessage(session, userMessage)
    }
  }

  // ─── Convenience methods ────────────────────────────────────────────────────

  /** Create a new session for a given agent */
  async newSession(agentId?: string, label?: string): Promise<ChatSession> {
    return this.sessions.create({
      agentId: agentId ?? this.defaultAgentId,
      ...(label !== undefined ? { label } : {}),
    })
  }

  /** Load an existing session */
  async loadSession(sessionId: string): Promise<ChatSession | undefined> {
    return this.sessions.load(sessionId)
  }

  /** List all sessions, optionally filtered by agent */
  async listSessions(agentId?: string): Promise<ChatSession[]> {
    return this.sessions.list(agentId)
  }

  /** Branch a session at a specific message */
  async branchSession(
    sessionId: string,
    options?: import('./types/session.js').BranchOptions,
  ): Promise<ChatSession> {
    const session = await this.sessions.load(sessionId)
    if (!session) throw new Error(`[Roy] Session "${sessionId}" not found.`)
    return this.sessions.branch(session, options)
  }

  /** Get all registered agent definitions */
  get agents(): AgentDefinition[] {
    return this.registry.all()
  }

  /** Estimate cost for a hypothetical turn */
  estimateCost(agentId: string, promptTokens: number, completionTokens: number) {
    const agent = this.registry.get(agentId)
    return this.costCalc.calculate(agent.model, promptTokens, completionTokens)
  }

  /** List all available models with pricing info */
  listModels(provider?: import('./types/provider.js').ProviderType) {
    return this.costCalc.listModels(provider)
  }
}

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Create a Roy chat instance.
 *
 * @example
 * ```ts
 * import { createChat } from '@roy/core'
 *
 * const roy = createChat({
 *   agents: [
 *     {
 *       id: 'assistant',
 *       name: 'Assistant',
 *       provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
 *       model: 'claude-sonnet-4-6',
 *       systemPrompt: 'You are a helpful assistant.',
 *       compaction: { watermarkTokens: 20_000 },
 *     },
 *   ],
 * })
 *
 * for await (const chunk of roy.send({ input: 'Hello!' })) {
 *   if (chunk.type === 'text') process.stdout.write(chunk.delta)
 * }
 * ```
 */
export function createChat(config: RoyConfig): Roy {
  return new Roy(config)
}
