import EventEmitter from 'eventemitter3'
import type { AgentDefinition } from '../types/agent.js'
import type { Message, StreamChunk } from '../types/message.js'
import type { ChatSession } from '../types/session.js'
import type { LLMProvider } from '../providers/types.js'
import type { AgentRegistry } from './registry.js'
import { CycleEngine } from './cycle-engine.js'
import { PlanEngine } from './plan-engine.js'
import { createProvider } from '../providers/factory.js'
import { CostCalculator, type CostCalculatorConfig } from '../cost/calculator.js'
import { generateId } from '../utils/id.js'

export interface HandoffRequest {
  targetAgentId: string
  reason?: string
  /** Pass full history or only summary to the next agent */
  contextMode?: 'full' | 'summary'
}

export interface OrchestratorEvents {
  'agent-start': [{ agentId: string; sessionId: string }]
  'agent-end': [{ agentId: string; sessionId: string; tokens: number; costUsd: number }]
  'agent-handoff': [{ from: string; to: string; hopNumber: number }]
  'plan-ready': [{ plan: import('../types/agent.js').PlanDocument }]
  'plan-approved': [{ plan: import('../types/agent.js').PlanDocument }]
  'plan-rejected': [{ plan: import('../types/agent.js').PlanDocument }]
  error: [Error]
}

/**
 * Orchestrator — coordinates agent execution, handoffs, and plan mode.
 * One Orchestrator instance per Roy chat instance.
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private planEngines = new Map<string, PlanEngine>()
  private readonly costCalc: CostCalculator
  private providers = new Map<string, LLMProvider>()

  constructor(
    private readonly registry: AgentRegistry,
    costConfig?: CostCalculatorConfig,
  ) {
    super()
    this.costCalc = new CostCalculator(costConfig)
  }

  getProvider(agent: AgentDefinition): LLMProvider {
    let provider = this.providers.get(agent.id)
    if (!provider) {
      provider = createProvider(agent.provider)
      this.providers.set(agent.id, provider)
    }
    return provider
  }

  getPlanEngine(agent: AgentDefinition, session: ChatSession): PlanEngine {
    const key = `${agent.id}:${session.id}`
    let engine = this.planEngines.get(key)
    if (!engine) {
      if (!agent.onPlanApproval) {
        throw new Error(
          `[Roy] Agent "${agent.id}" has planMode: true but no onPlanApproval callback defined.`,
        )
      }
      engine = new PlanEngine(
        agent.id,
        session.id,
        this.getProvider(agent),
        agent.model,
        agent.onPlanApproval,
      )
      this.planEngines.set(key, engine)
    }
    return engine
  }

  /**
   * Run a single agent turn, yielding stream chunks.
   * Handles plan mode gating and cost annotation.
   */
  async *runTurn(
    agent: AgentDefinition,
    session: ChatSession,
    userMessage: Message,
    options: { signal?: AbortSignal | undefined } = {},
  ): AsyncIterable<StreamChunk> {
    const provider = this.getProvider(agent)
    this.emit('agent-start', { agentId: agent.id, sessionId: session.id })

    // In plan mode, block tool execution until approved
    if (agent.planMode) {
      const planEngine = this.getPlanEngine(agent, session)

      // Inject plan mode instructions into system prompt
      const planSystemSuffix = planEngine.isExecuting
        ? '\n\nYou are now in EXECUTION mode. You may use tools and take actions.'
        : '\n\nYou are in PLAN mode. Your goal is to gather information by asking clarifying questions. ' +
          'Do NOT take any actions or call any tools yet. Once you have all required information, ' +
          'say "[PLAN_READY]" to signal you are ready to create the execution plan.'

      const systemPrompt = (agent.systemPrompt ?? '') + planSystemSuffix
      const tools = planEngine.isExecuting ? agent.tools : undefined

      // Record the user message so plan extraction sees all sides of the conversation
      planEngine.onUserMessage(userMessage)

      let fullText = ''
      let promptTokens = 0
      let completionTokens = 0

      for await (const chunk of provider.stream({
        model: agent.model,
        systemPrompt,
        messages: [...session.messages, userMessage] as Message[],
        tools,
        signal: options.signal,
      })) {
        if (chunk.type === 'text') fullText += chunk.delta
        if (chunk.type === 'usage') {
          promptTokens = chunk.promptTokens
          completionTokens = chunk.completionTokens
        }
        yield chunk
      }

      // After streaming, process plan mode state
      const assistantMsg: Message = {
        id: generateId(),
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        agentId: agent.id,
        createdAt: new Date().toISOString(),
        cost: this.costCalc.calculate(agent.model, promptTokens, completionTokens),
      }

      if (!planEngine.isExecuting) {
        await planEngine.onAssistantMessage(assistantMsg)
        if (planEngine.currentPlan?.status === 'pending_approval') {
          this.emit('plan-ready', { plan: planEngine.currentPlan })
        } else if (planEngine.currentPlan?.status === 'approved') {
          this.emit('plan-approved', { plan: planEngine.currentPlan })
        } else if (planEngine.currentPlan?.status === 'rejected') {
          this.emit('plan-rejected', { plan: planEngine.currentPlan })
        }
      }

      this.emit('agent-end', {
        agentId: agent.id,
        sessionId: session.id,
        tokens: promptTokens + completionTokens,
        costUsd: assistantMsg.cost?.estimatedCostUsd ?? 0,
      })
      return
    }

    // Normal (non-plan) mode
    let promptTokens = 0
    let completionTokens = 0

    for await (const chunk of provider.stream({
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      messages: [...session.messages, userMessage] as Message[],
      tools: agent.tools,
      signal: options.signal,
    })) {
      if (chunk.type === 'usage') {
        promptTokens = chunk.promptTokens
        completionTokens = chunk.completionTokens
      }
      yield chunk
    }

    const turnCost = this.costCalc.calculate(agent.model, promptTokens, completionTokens)
    this.emit('agent-end', {
      agentId: agent.id,
      sessionId: session.id,
      tokens: promptTokens + completionTokens,
      costUsd: turnCost.estimatedCostUsd,
    })
  }

  /**
   * Perform a multi-agent handoff.
   * Returns the new agent to continue with.
   */
  async handoff(
    request: HandoffRequest,
    currentAgentId: string,
    cycleEngine: CycleEngine,
    lastMessageContent: string,
  ): Promise<AgentDefinition> {
    const resolvedId = await cycleEngine.requestHandoff(
      currentAgentId,
      request.targetAgentId,
      { lastMessageContent, metadata: {} },
    )

    const hop = cycleEngine.getHistory().at(-1)
    if (hop) {
      this.emit('agent-handoff', {
        from: currentAgentId,
        to: resolvedId,
        hopNumber: hop.hopNumber,
      })
    }

    return this.registry.get(resolvedId)
  }
}
