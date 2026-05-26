import type { ToolDefinition } from './tool.js'
import type { CompactionStrategyDescriptor } from '../context/types.js'
import type { ProviderConfig } from './provider.js'

// ─── Cycle configuration ─────────────────────────────────────────────────────

export type LoopStrategy =
  | 'break' // Stop the cycle immediately when a loop is detected
  | 'retry' // Retry the current hop with a modified prompt
  | 'escalate' // Hand off to the next agent in the chain

export interface CycleConfig {
  /** Maximum number of agent-to-agent hops before forcing a stop. Default: 10 */
  maxHops?: number
  /** What to do when a cycle (A→B→A) is detected */
  loopStrategy?: LoopStrategy
  /** Milliseconds to wait between hops. Useful to prevent runaway loops. Default: 0 */
  hopCooldownMs?: number
  /**
   * Explicit allowlist of agent IDs this agent may hand off to.
   * If undefined, handoff to any registered agent is permitted.
   */
  allowedHandoffTargets?: string[]
  /**
   * Dynamic routing function. If provided, called on each hop to determine
   * the next agent. Return undefined to let the orchestrator decide.
   */
  routingFn?: (context: CycleRoutingContext) => string | undefined | Promise<string | undefined>
}

export interface CycleRoutingContext {
  currentAgentId: string
  hopCount: number
  lastMessageContent: string
  sessionId: string
  metadata: Record<string, unknown>
}

// ─── Plan mode ───────────────────────────────────────────────────────────────

export type PlanStatus = 'drafting' | 'pending_approval' | 'approved' | 'rejected' | 'executing'

export interface PlanStep {
  id: string
  order: number
  title: string
  description: string
  /** Whether this step has side effects (API calls, file writes, etc.) */
  hasSideEffects: boolean
  /** Estimated cost range if applicable */
  estimatedCostUsd?: { min: number; max: number }
}

export interface PlanDocument {
  id: string
  sessionId: string
  agentId: string
  title: string
  goal: string
  steps: PlanStep[]
  constraints?: string[]
  status: PlanStatus
  createdAt: string
  approvedAt?: string
  rejectedAt?: string
  rejectionReason?: string
}

/**
 * Programmatic approval callback for plan mode.
 * Return true to approve, false to reject.
 * Optionally return a rejection reason.
 */
export type PlanApprovalCallback = (
  plan: PlanDocument,
) => Promise<{ approved: boolean; rejectionReason?: string }>

// ─── Compaction configuration ─────────────────────────────────────────────────

export interface CompactionConfig {
  /**
   * The strategy to use for compaction.
   * Can be a built-in strategy name or a CompactionStrategyDescriptor.
   * Default: 'rolling'
   */
  strategy?: 'rolling' | 'sliding' | CompactionStrategyDescriptor

  /**
   * Token watermark at which rolling compaction fires.
   * Default: 20_000
   */
  watermarkTokens?: number

  /**
   * Number of messages to summarize per compaction pass.
   * Default: half of the current conversation (oldest half).
   */
  batchSize?: number

  /**
   * Custom prompt used when summarizing old messages.
   * Use {{messages}} as the placeholder for the serialized messages.
   *
   * @example
   * ```ts
   * summaryPrompt: `
   *   You are a precise summarizer. Compress the following conversation
   *   into a concise summary, preserving all key decisions, facts, and
   *   action items. Do not add any information not present in the input.
   *
   *   Conversation:
   *   {{messages}}
   * `
   * ```
   */
  summaryPrompt?: string

  /**
   * Maximum number of compaction passes before triggering a session rollover.
   * Default: undefined (no limit — will keep compacting until impossible).
   */
  maxCompactionPasses?: number
}

// ─── Agent definition ─────────────────────────────────────────────────────────

/**
 * An AgentDefinition is the contract for creating an agent in Roy.
 * It must be provided by the host project — Roy does not create implicit agents.
 *
 * @example
 * ```ts
 * const myAgent: AgentDefinition = {
 *   id: 'support',
 *   name: 'Support Agent',
 *   provider: { type: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
 *   model: 'openai/gpt-4o-mini',
 *   systemPrompt: 'You are a helpful support agent for Acme Corp.',
 *   tools: [lookupOrderTool, refundTool],
 *   compaction: { watermarkTokens: 15_000 },
 * }
 * ```
 */
export interface AgentDefinition {
  /** Unique identifier for this agent within the host project */
  id: string
  /** Human-readable display name */
  name: string
  /** Provider + auth configuration */
  provider: ProviderConfig
  /** The model to use — must be supported by the chosen provider */
  model: string
  /** System prompt that defines this agent's persona and behavior */
  systemPrompt: string
  /** Tools available to this agent */
  tools?: ToolDefinition[]
  /** Context compaction configuration */
  compaction?: CompactionConfig
  /** Multi-agent cycle configuration */
  cycle?: CycleConfig
  /**
   * If true, this agent operates in plan mode:
   * it collects requirements, emits a PlanDocument, and waits for approval
   * before executing any tools or side-effecting operations.
   */
  planMode?: boolean
  /**
   * Approval callback for plan mode. Required if planMode is true.
   * Called with the PlanDocument when the agent is ready to execute.
   */
  onPlanApproval?: PlanApprovalCallback
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>
}
