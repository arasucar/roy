import EventEmitter from 'eventemitter3'
import type { AgentDefinition, CompactionConfig } from './types/agent.js'
import type { Message, StreamChunk } from './types/message.js'
import type { ChatSession, StorageAdapter } from './types/session.js'
import type { MemoryConfig } from './types/memory.js'
import type { LLMProvider } from './providers/types.js'
import type {
  CompactionEvent,
  RollingCompactorConfig,
  SessionRolloverEvent,
} from './context/rolling.js'
import type { CompactionStrategy, CompactionStrategyDescriptor } from './context/types.js'
import { AgentRegistry } from './agents/registry.js'
import { Orchestrator } from './agents/orchestrator.js'
import type { OrchestratorEvents } from './agents/orchestrator.js'
import { SessionManager } from './session/manager.js'
import { MemoryStore } from './session/stores/memory-store.js'
import { RollingCompactor } from './context/rolling.js'
import { SlidingWindowStrategy } from './context/sliding.js'
import { SummarizationStrategy } from './context/summarization.js'
import { defaultStrategyRegistry } from './context/types.js'
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
  /**
   * In plan mode, explicitly request plan drafting after this turn. Roy does
   * not infer plan readiness from assistant text.
   */
  requestPlan?: boolean
}

// ─── Roy instance events ──────────────────────────────────────────────────────

export interface RoyEvents {
  'agent-start': [OrchestratorEvents['agent-start'][0]]
  'agent-end': [OrchestratorEvents['agent-end'][0]]
  'tool-call': [OrchestratorEvents['tool-call'][0]]
  'tool-result': [OrchestratorEvents['tool-result'][0]]
  handoff: [OrchestratorEvents['handoff'][0]]
  compacted: [CompactionEvent]
  'session-rollover': [SessionRolloverEvent]
  'agent-handoff': [OrchestratorEvents['agent-handoff'][0]]
  'plan-ready': [{ plan: import('./types/agent.js').PlanDocument }]
  'approval-requested': [{ plan: import('./types/agent.js').PlanDocument }]
  'plan-approved': [{ plan: import('./types/agent.js').PlanDocument }]
  'plan-rejected': [{ plan: import('./types/agent.js').PlanDocument }]
  'cost-updated': [OrchestratorEvents['cost-updated'][0]]
  done: [OrchestratorEvents['done'][0]]
  error: [OrchestratorEvents['error'][0]]
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

    // Forward stable host-app run events
    this.orchestrator.on('agent-start', (e) => this.emit('agent-start', e))
    this.orchestrator.on('agent-end', (e) => this.emit('agent-end', e))
    this.orchestrator.on('tool-call', (e) => this.emit('tool-call', e))
    this.orchestrator.on('tool-result', (e) => this.emit('tool-result', e))
    this.orchestrator.on('handoff', (e) => this.emit('handoff', e))
    this.orchestrator.on('agent-handoff', (e) => this.emit('agent-handoff', e))
    this.orchestrator.on('plan-ready', (e) => this.emit('plan-ready', e))
    this.orchestrator.on('approval-requested', (e) => this.emit('approval-requested', e))
    this.orchestrator.on('plan-approved', (e) => this.emit('plan-approved', e))
    this.orchestrator.on('plan-rejected', (e) => this.emit('plan-rejected', e))
    this.orchestrator.on('error', (e) => this.emit('error', e))

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
  async *send<TInput = string>(options: SendOptions<TInput>): AsyncIterable<StreamChunk> {
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

    // Build the user message before compaction so the watermark check includes
    // the incoming turn without letting compaction rewrite that fresh input.
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: [
        {
          type: 'text',
          text: typeof options.input === 'string' ? options.input : JSON.stringify(options.input),
        },
      ],
      input: options.input,
      createdAt: new Date().toISOString(),
      metadata: {
        ...options.metadata,
        ...(options.memoryMarker ? { memoryMarker: options.memoryMarker } : {}),
      },
    }

    // Get or create the compactor for this session
    let compactor = this.compactors.get(session.id)
    if (!compactor) {
      compactor = createRollingCompactor(
        agent,
        provider,
        this.memoryExtractor
          ? (messages, context) =>
              this.memoryExtractor!.extractFromMessages(messages, context.session.id)
          : undefined,
      )

      compactor.on('compacted', (e) => this.emit('compacted', e))
      compactor.on('session-rollover', async (e) => {
        await this.sessions.save(e.newSession)
        await this.sessions.markRolledOver(e.oldSession, e.newSessionId)
        // Extract memory from the old session before it's gone (if configured)
        if (this.memoryExtractor) {
          const markedMessages = e.oldSession.messages.filter((m) => m.metadata?.['memoryMarker'])
          if (markedMessages.length > 0) {
            await this.memoryExtractor.extractFromMessages(markedMessages, e.oldSession.id)
          }
        }
        // Clean up the old compactor — the new session will get a fresh one on next send
        this.compactors.delete(e.oldSession.id)
        this.emit('session-rollover', e)
      })

      this.compactors.set(session.id, compactor)
    }

    // PRE-COMPACTION: check watermark before sending
    session = await compactor.maybeCompact(session, provider, agent.model, {
      systemPrompt: effectiveSystemPrompt,
      pendingMessages: [userMessage],
    })

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
      {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.requestPlan !== undefined ? { requestPlan: options.requestPlan } : {}),
      },
    )) {
      if (chunk.type === 'usage') {
        promptTokens += chunk.promptTokens
        completionTokens += chunk.completionTokens
        cacheCreationInputTokens += chunk.cacheCreationInputTokens ?? 0
        cacheReadInputTokens += chunk.cacheReadInputTokens ?? 0
      }
      if (chunk.type === 'done') {
        const turnCost = this.costCalc.calculate(agent.model, {
          promptTokens,
          completionTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
        })
        const finalTurnMessage: Message = {
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
        finalMessage = finalTurnMessage
        const turnMessages = chunk.messages ?? [chunk.message]
        const messagesToSave = turnMessages.map((message, index) => {
          const isFinal = message.id === chunk.message.id || index === turnMessages.length - 1
          if (isFinal) return finalTurnMessage
          if (message.role === 'assistant' && message.agentId === undefined) {
            return { ...message, agentId }
          }
          return message
        })

        // Save messages
        session = await this.sessions.appendMessage(session, userMessage)
        for (const message of messagesToSave) {
          session = await this.sessions.appendMessage(session, message)
        }
        session = await this.sessions.updateTokenBudget(
          session,
          provider.estimateTokens(session.messages, effectiveSystemPrompt),
        )

        this.emit('cost-updated', {
          agentId,
          sessionId: session.id,
          cost: turnCost,
        })
        this.emit('done', {
          agentId,
          sessionId: session.id,
          message: finalTurnMessage,
          messages: messagesToSave,
        })
        yield { ...chunk, message: finalTurnMessage, messages: messagesToSave }
        continue
      }
      yield chunk
    }

    // Guard: if stream ended without a done chunk (provider error or abort),
    // still persist the user message so the session isn't left in a broken state.
    if (!finalMessage && !options.signal?.aborted) {
      const err = new Error('[Roy] Stream ended without a done chunk — provider may have errored.')
      this.emit('error', { agentId, sessionId: session.id, error: err })
      // Still save the user message — the assistant turn is simply absent
      session = await this.sessions.appendMessage(session, userMessage)
      await this.sessions.updateTokenBudget(
        session,
        provider.estimateTokens(session.messages, effectiveSystemPrompt),
      )
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

  /** Explicitly draft and gate a plan for an existing plan-mode session. */
  async requestPlan(
    sessionId: string,
    agentId?: string,
  ): Promise<import('./types/agent.js').PlanDocument> {
    const session = await this.sessions.load(sessionId)
    if (!session) throw new Error(`[Roy] Session "${sessionId}" not found.`)
    const agent = this.registry.get(agentId ?? session.agentId)
    return this.orchestrator.requestPlan(agent, session)
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
 * import { createChat } from '@chatroy/core'
 *
 * const roy = createChat({
 *   agents: [
 *     {
 *       id: 'assistant',
 *       name: 'Assistant',
 *       provider: { type: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY! },
 *       model: 'openai/gpt-4o-mini',
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

function createRollingCompactor(
  agent: AgentDefinition,
  provider: LLMProvider,
  onMessagesCompacted?: RollingCompactorConfig['onMessagesCompacted'],
): RollingCompactor {
  const compaction = agent.compaction ?? {}
  const summaryModel = compaction.summaryModel ?? agent.model
  const config: RollingCompactorConfig = { provider, summaryModel }
  if (onMessagesCompacted) config.onMessagesCompacted = onMessagesCompacted

  if (compaction.triggerFraction !== undefined) config.triggerFraction = compaction.triggerFraction
  if (compaction.targetFraction !== undefined) config.targetFraction = compaction.targetFraction
  if (compaction.reserveOutputTokens !== undefined) {
    config.reserveOutputTokens = compaction.reserveOutputTokens
  }
  // Pass watermarkTokens through ONLY if the agent set it explicitly —
  // otherwise the % watermark computes a model-aware budget.
  if (compaction.watermarkTokens !== undefined) config.watermarkTokens = compaction.watermarkTokens
  if (compaction.maxCompactionPasses !== undefined) {
    config.maxPasses = compaction.maxCompactionPasses
  }
  if (compaction.summaryPrompt !== undefined) config.summaryPrompt = compaction.summaryPrompt
  if (compaction.batchSize !== undefined) config.summaryBatchSize = compaction.batchSize
  if (compaction.toolTruncation !== undefined) config.toolTruncation = compaction.toolTruncation

  const strategy = resolveCompactionStrategy(compaction, provider, summaryModel)
  if (strategy) config.strategy = strategy

  return new RollingCompactor(config)
}

function resolveCompactionStrategy(
  compaction: CompactionConfig,
  provider: LLMProvider,
  model: string,
): CompactionStrategy | undefined {
  if (!compaction.strategy || compaction.strategy === 'rolling') return undefined

  if (compaction.strategy === 'sliding') {
    return new SlidingWindowStrategy({
      ...(compaction.batchSize !== undefined ? { keepLastN: compaction.batchSize } : {}),
    })
  }

  const builtIn = createBuiltInDescriptorStrategy(compaction.strategy, provider, model)
  if (builtIn) return builtIn

  const registered = defaultStrategyRegistry.get(compaction.strategy.descriptorId)
  if (!registered) {
    throw new Error(
      `[Roy] Unknown compaction strategy descriptor: "${compaction.strategy.descriptorId}".`,
    )
  }
  return registered
}

function createBuiltInDescriptorStrategy(
  descriptor: CompactionStrategyDescriptor,
  provider: LLMProvider,
  model: string,
): CompactionStrategy | undefined {
  if (descriptor.descriptorId === 'sliding-window') {
    const keepLastN = numberConfig(descriptor.config, 'keepLastN')
    const preserveSystem = booleanConfig(descriptor.config, 'preserveSystem')
    const config: { keepLastN?: number; preserveSystem?: boolean } = {}
    if (keepLastN !== undefined) config.keepLastN = keepLastN
    if (preserveSystem !== undefined) config.preserveSystem = preserveSystem
    return new SlidingWindowStrategy(config)
  }

  if (descriptor.descriptorId === 'summarization') {
    const summaryPrompt = stringConfig(descriptor.config, 'summaryPrompt')
    const batchRatio = numberConfig(descriptor.config, 'batchRatio')
    const batchSize = numberConfig(descriptor.config, 'batchSize')
    const minMessages = numberConfig(descriptor.config, 'minMessages')
    return new SummarizationStrategy({
      provider,
      model: stringConfig(descriptor.config, 'model') ?? model,
      ...(summaryPrompt !== undefined ? { summaryPrompt } : {}),
      ...(batchRatio !== undefined ? { batchRatio } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      ...(minMessages !== undefined ? { minMessages } : {}),
    })
  }

  return undefined
}

function numberConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = config?.[key]
  return typeof value === 'number' ? value : undefined
}

function stringConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key]
  return typeof value === 'string' ? value : undefined
}

function booleanConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = config?.[key]
  return typeof value === 'boolean' ? value : undefined
}
