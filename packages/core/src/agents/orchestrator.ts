import EventEmitter from 'eventemitter3'
import type { AgentDefinition } from '../types/agent.js'
import type { Message, StreamChunk } from '../types/message.js'
import type { ChatSession } from '../types/session.js'
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tool.js'
import type { LLMProvider } from '../providers/types.js'
import type { AgentRegistry } from './registry.js'
import { CycleEngine } from './cycle-engine.js'
import { PlanEngine } from './plan-engine.js'
import { createProvider } from '../providers/factory.js'
import { CostCalculator, type CostCalculatorConfig } from '../cost/calculator.js'
import type { TurnCost } from '../cost/calculator.js'
import { generateId } from '../utils/id.js'

export interface HandoffRequest {
  targetAgentId: string
  reason?: string
  /** Whether the handoff event should carry full-context intent or a compact summary. */
  contextMode?: 'full' | 'summary'
}

export interface HandoffContext {
  mode: 'summary'
  reason?: string
  summary: string
  sourceMessageIds: string[]
}

export interface AgentRunEvent {
  agentId: string
  sessionId: string
}

export interface AgentEndEvent extends AgentRunEvent {
  tokens: number
  costUsd: number
}

export interface ToolCallEvent extends AgentRunEvent {
  toolCall: ToolCall
}

export interface ToolResultEvent extends AgentRunEvent {
  toolResult: ToolResult
}

export interface HandoffEvent {
  from: string
  to: string
  hopNumber: number
  contextMode: 'full' | 'summary'
  handoffContext?: HandoffContext
}

export interface PlanEvent {
  plan: import('../types/agent.js').PlanDocument
}

export interface CostUpdatedEvent extends AgentRunEvent {
  cost: TurnCost
}

export interface RunDoneEvent extends AgentRunEvent {
  message: Message
  messages?: Message[]
}

export interface RunErrorEvent extends Partial<AgentRunEvent> {
  error: Error
}

export interface OrchestratorEvents {
  'agent-start': [AgentRunEvent]
  'agent-end': [AgentEndEvent]
  'tool-call': [ToolCallEvent]
  'tool-result': [ToolResultEvent]
  handoff: [HandoffEvent]
  'agent-handoff': [HandoffEvent]
  'plan-ready': [PlanEvent]
  'approval-requested': [PlanEvent]
  'plan-approved': [PlanEvent]
  'plan-rejected': [PlanEvent]
  'cost-updated': [CostUpdatedEvent]
  done: [RunDoneEvent]
  error: [RunErrorEvent]
}

const MAX_TOOL_ITERATIONS = 5

/**
 * Orchestrator — runs single agent turns and exposes handoff/plan primitives.
 * It does not own a durable multi-agent workflow loop.
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

  async requestPlan(agent: AgentDefinition, session: ChatSession): Promise<PlanEvent['plan']> {
    if (!agent.planMode) {
      throw new Error(`[Roy] Agent "${agent.id}" does not have planMode enabled.`)
    }

    const planEngine = this.getPlanEngine(agent, session)
    const plan = await planEngine.requestPlan(session.messages)
    this.emit('plan-ready', { plan })
    this.emit('approval-requested', { plan })

    const decidedPlan = await planEngine.requestApproval()
    if (decidedPlan?.status === 'approved') {
      this.emit('plan-approved', { plan: decidedPlan })
      return decidedPlan
    }
    if (decidedPlan?.status === 'rejected') {
      this.emit('plan-rejected', { plan: decidedPlan })
      return decidedPlan
    }
    return plan
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
    options: { signal?: AbortSignal | undefined; requestPlan?: boolean | undefined } = {},
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
          'Do NOT take any actions or call any tools yet. The host application will explicitly request plan drafting when ready.'

      const systemPrompt = (agent.systemPrompt ?? '') + planSystemSuffix
      const tools = planEngine.isExecuting ? agent.tools : undefined

      // Record the user message so plan extraction sees all sides of the conversation
      planEngine.onUserMessage(userMessage)

      let fullText = ''
      let promptTokens = 0
      let completionTokens = 0
      let cacheCreationInputTokens = 0
      let cacheReadInputTokens = 0
      let doneChunk: Extract<StreamChunk, { type: 'done' }> | undefined

      for await (const chunk of this.streamProviderTurn({
        provider,
        agent: { ...agent, systemPrompt },
        sessionId: session.id,
        messages: [...session.messages, userMessage] as Message[],
        tools,
        signal: options.signal,
      })) {
        if (chunk.type === 'text') fullText += chunk.delta
        if (chunk.type === 'usage') {
          promptTokens += chunk.promptTokens
          completionTokens += chunk.completionTokens
          cacheCreationInputTokens += chunk.cacheCreationInputTokens ?? 0
          cacheReadInputTokens += chunk.cacheReadInputTokens ?? 0
        }
        if (chunk.type === 'error') {
          this.emit('error', { agentId: agent.id, sessionId: session.id, error: chunk.error })
        }
        if (chunk.type === 'done') {
          doneChunk = chunk
          continue
        }
        yield chunk
      }

      // After streaming, process plan mode state
      const turnCost = this.costCalc.calculate(agent.model, {
        promptTokens,
        completionTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
      })
      const assistantMsg: Message = {
        id: generateId(),
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        agentId: agent.id,
        createdAt: new Date().toISOString(),
        cost: turnCost,
      }

      if (!planEngine.isExecuting) {
        planEngine.onAssistantMessage(assistantMsg)
        if (options.requestPlan) {
          const plan = await planEngine.requestPlan([
            ...session.messages,
            userMessage,
            assistantMsg,
          ])
          this.emit('plan-ready', { plan })
          this.emit('approval-requested', { plan })
          const decidedPlan = await planEngine.requestApproval()
          if (decidedPlan?.status === 'approved') {
            this.emit('plan-approved', { plan: decidedPlan })
          } else if (decidedPlan?.status === 'rejected') {
            this.emit('plan-rejected', { plan: decidedPlan })
          }
        }
      }

      this.emit('cost-updated', {
        agentId: agent.id,
        sessionId: session.id,
        cost: turnCost,
      })
      this.emit('agent-end', {
        agentId: agent.id,
        sessionId: session.id,
        tokens: promptTokens + completionTokens,
        costUsd: assistantMsg.cost?.estimatedCostUsd ?? 0,
      })
      const doneEvent = {
        agentId: agent.id,
        sessionId: session.id,
        message: doneChunk?.message ?? assistantMsg,
        ...(doneChunk?.messages !== undefined ? { messages: doneChunk.messages } : {}),
      }
      this.emit('done', doneEvent)
      yield {
        type: 'done',
        message: doneEvent.message,
        ...(doneEvent.messages !== undefined ? { messages: doneEvent.messages } : {}),
      }
      return
    }

    if (options.requestPlan) {
      const error = new Error(
        `[Roy] requestPlan requires agent "${agent.id}" to have planMode enabled.`,
      )
      this.emit('error', { agentId: agent.id, sessionId: session.id, error })
      throw error
    }

    // Normal (non-plan) mode
    let promptTokens = 0
    let completionTokens = 0
    let cacheCreationInputTokens = 0
    let cacheReadInputTokens = 0
    let doneChunk: Extract<StreamChunk, { type: 'done' }> | undefined

    for await (const chunk of this.streamProviderTurn({
      provider,
      agent,
      sessionId: session.id,
      messages: [...session.messages, userMessage] as Message[],
      tools: agent.tools,
      signal: options.signal,
    })) {
      if (chunk.type === 'usage') {
        promptTokens += chunk.promptTokens
        completionTokens += chunk.completionTokens
        cacheCreationInputTokens += chunk.cacheCreationInputTokens ?? 0
        cacheReadInputTokens += chunk.cacheReadInputTokens ?? 0
      }
      if (chunk.type === 'error') {
        this.emit('error', { agentId: agent.id, sessionId: session.id, error: chunk.error })
      }
      if (chunk.type === 'done') {
        doneChunk = chunk
      }
      yield chunk
    }

    const turnCost = this.costCalc.calculate(agent.model, {
      promptTokens,
      completionTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    })
    this.emit('cost-updated', {
      agentId: agent.id,
      sessionId: session.id,
      cost: turnCost,
    })
    this.emit('agent-end', {
      agentId: agent.id,
      sessionId: session.id,
      tokens: promptTokens + completionTokens,
      costUsd: turnCost.estimatedCostUsd,
    })
    if (doneChunk) {
      this.emit('done', {
        agentId: agent.id,
        sessionId: session.id,
        message: doneChunk.message,
        ...(doneChunk.messages !== undefined ? { messages: doneChunk.messages } : {}),
      })
    }
  }

  private async *streamProviderTurn(options: {
    provider: LLMProvider
    agent: AgentDefinition
    sessionId: string
    messages: Message[]
    tools?: ToolDefinition[] | undefined
    signal?: AbortSignal | undefined
  }): AsyncIterable<StreamChunk> {
    const messages = [...options.messages]
    const turnMessages: Message[] = []
    const canFeedToolResults =
      options.provider.type === 'anthropic' ||
      options.provider.type === 'gemini' ||
      options.provider.type === 'openai' ||
      options.provider.type === 'openrouter' ||
      options.provider.type === 'ollama'

    for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration += 1) {
      const pendingToolCalls = new Map<string, ToolCall>()
      let fullText = ''
      let done: Extract<StreamChunk, { type: 'done' }> | undefined

      for await (const chunk of options.provider.stream({
        model: options.agent.model,
        systemPrompt: options.agent.systemPrompt,
        messages,
        tools: options.tools,
        signal: options.signal,
      })) {
        if (chunk.type === 'text') {
          fullText += chunk.delta
          yield chunk
          continue
        }
        if (chunk.type === 'tool_call') {
          mergeToolCallDelta(pendingToolCalls, chunk)
          yield chunk
          continue
        }
        if (chunk.type === 'done') {
          done = chunk
          continue
        }

        yield chunk
      }

      const toolCalls = [...pendingToolCalls.values()]
      if (toolCalls.length === 0 || !canFeedToolResults) {
        const message = done?.message ?? buildAssistantTextMessage(fullText)
        yield {
          type: 'done',
          message,
          messages: [...turnMessages, message],
        }
        return
      }

      for (const toolCall of toolCalls) {
        this.emit('tool-call', {
          agentId: options.agent.id,
          sessionId: options.sessionId,
          toolCall,
        })
      }

      if (iteration === MAX_TOOL_ITERATIONS) {
        const error = new Error(`[Roy] Tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations.`)
        yield { type: 'error', error }
        const message = buildAssistantTextMessage(error.message)
        yield {
          type: 'done',
          message,
          messages: [...turnMessages, message],
        }
        return
      }

      const assistantToolMessage = buildAssistantToolMessage(
        fullText || messageText(done?.message),
        toolCalls,
        options.agent.id,
      )
      turnMessages.push(assistantToolMessage)
      messages.push(assistantToolMessage)

      for (const toolResult of await executeToolCalls(toolCalls, options.tools ?? [])) {
        const toolMessage = buildToolResultMessage(toolResult)
        turnMessages.push(toolMessage)
        messages.push(toolMessage)
        this.emit('tool-result', {
          agentId: options.agent.id,
          sessionId: options.sessionId,
          toolResult,
        })
        yield {
          type: 'tool_result',
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.name,
          result: toolResult.result,
          ...(toolResult.isError !== undefined ? { isError: toolResult.isError } : {}),
        }
      }
    }
  }

  /**
   * Validate and describe a handoff request.
   * Roy returns the target agent and emits handoff context; the host app owns
   * the surrounding workflow loop, retries, persistence, and scheduling.
   */
  async handoff(
    request: HandoffRequest,
    currentAgentId: string,
    cycleEngine: CycleEngine,
    lastMessageContent: string,
    session?: ChatSession,
  ): Promise<AgentDefinition> {
    const handoffContext = buildHandoffContext(request, session, lastMessageContent)
    const resolvedId = await cycleEngine.requestHandoff(currentAgentId, request.targetAgentId, {
      lastMessageContent,
      metadata: handoffContext ? { handoffContext } : {},
    })

    const hop = cycleEngine.getHistory().at(-1)
    if (hop) {
      const event: HandoffEvent = {
        from: currentAgentId,
        to: resolvedId,
        hopNumber: hop.hopNumber,
        contextMode: request.contextMode ?? 'full',
        ...(handoffContext ? { handoffContext } : {}),
      }
      this.emit('handoff', event)
      this.emit('agent-handoff', event)
    }

    return this.registry.get(resolvedId)
  }
}

function mergeToolCallDelta(
  pending: Map<string, ToolCall>,
  chunk: Extract<StreamChunk, { type: 'tool_call' }>,
): void {
  const current = pending.get(chunk.toolCallId) ?? {
    id: chunk.toolCallId,
    name: chunk.toolName,
    arguments: '',
  }
  pending.set(chunk.toolCallId, {
    ...current,
    name: chunk.toolName || current.name,
    arguments: current.arguments + chunk.argumentsDelta,
  })
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  tools: ToolDefinition[],
): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map((call) => executeToolCall(call, tools)))
}

async function executeToolCall(call: ToolCall, tools: ToolDefinition[]): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.name)
  if (!tool) {
    return toolError(call, `Tool "${call.name}" is not registered.`)
  }

  let rawInput: unknown
  try {
    rawInput = call.arguments.trim() ? JSON.parse(call.arguments) : {}
  } catch (error) {
    return toolError(call, `Invalid JSON arguments: ${errorMessage(error)}`)
  }

  const parsed = tool.parameters.safeParse(rawInput)
  if (!parsed.success) {
    return toolError(call, parsed.error.message)
  }

  try {
    const result = await (tool.execute as (input: unknown) => Promise<unknown>)(parsed.data)
    return {
      toolCallId: call.id,
      name: call.name,
      result,
    }
  } catch (error) {
    return toolError(call, errorMessage(error))
  }
}

function toolError(call: ToolCall, message: string): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    result: { error: message },
    isError: true,
  }
}

function buildAssistantToolMessage(text: string, toolCalls: ToolCall[], agentId: string): Message {
  return {
    id: generateId(),
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((toolCall) => ({
        type: 'tool_call' as const,
        toolCall,
      })),
    ],
    agentId,
    createdAt: new Date().toISOString(),
  }
}

function buildToolResultMessage(toolResult: ToolResult): Message {
  return {
    id: generateId(),
    role: 'tool',
    content: [{ type: 'tool_result', toolResult }],
    createdAt: new Date().toISOString(),
  }
}

function buildAssistantTextMessage(text: string): Message {
  return {
    id: generateId(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: new Date().toISOString(),
  }
}

function messageText(message: Message | undefined): string {
  return (
    message?.content
      .flatMap((b) => (b.type === 'text' || b.type === 'summary' ? [b.text] : []))
      .join('\n') ?? ''
  )
}

function buildHandoffContext(
  request: HandoffRequest,
  session: ChatSession | undefined,
  lastMessageContent: string,
): HandoffContext | undefined {
  if ((request.contextMode ?? 'full') !== 'summary') return undefined

  const recentMessages = session?.messages.slice(-8) ?? []
  const sourceMessageIds = recentMessages.map((m) => m.id)
  const recentContext = recentMessages.map(serializeMessageForHandoff).join('\n\n')
  const parts = [
    request.reason ? `Reason: ${request.reason}` : '',
    recentContext ? `Recent context:\n${recentContext}` : '',
    lastMessageContent ? `Last message:\n${lastMessageContent}` : '',
  ].filter(Boolean)

  return {
    mode: 'summary',
    ...(request.reason ? { reason: request.reason } : {}),
    summary: clampText(parts.join('\n\n'), 6_000),
    sourceMessageIds,
  }
}

function serializeMessageForHandoff(message: Message): string {
  const text = message.content.map(serializeContentBlock).filter(Boolean).join('\n')
  return `[${message.role}${message.agentId ? ` (${message.agentId})` : ''} #${message.id}]: ${text}`
}

function serializeContentBlock(block: Message['content'][number]): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'summary':
      return `[summary replacing ${block.replacedCount} messages]: ${block.text}`
    case 'tool_call':
      return `[tool_call ${block.toolCall.name}#${block.toolCall.id}]: ${block.toolCall.arguments}`
    case 'tool_result':
      return `[tool_result ${block.toolResult.name}#${block.toolResult.toolCallId}${
        block.toolResult.isError ? ' error' : ''
      }]: ${serializeToolResult(block.toolResult.result)}`
  }
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[handoff context truncated]`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
