import type { CycleConfig, CycleRoutingContext } from '../types/agent.js'
import type { AgentRegistry } from './registry.js'

export interface HopRecord {
  fromAgentId: string
  toAgentId: string
  hopNumber: number
  timestamp: string
}

export class CycleEngineError extends Error {
  constructor(
    message: string,
    public readonly code: 'MAX_HOPS' | 'LOOP_DETECTED' | 'DISALLOWED_TARGET',
  ) {
    super(message)
    this.name = 'CycleEngineError'
  }
}

/**
 * CycleEngine validates and tracks agent-to-agent handoffs.
 *
 * Configuration (per AgentDefinition.cycle):
 * - maxHops: stop after N hops
 * - loopStrategy: what to do when A→B→A detected
 * - allowedHandoffTargets: allowlist of agent IDs
 * - hopCooldownMs: delay between hops
 * - routingFn: dynamic routing override
 */
export class CycleEngine {
  private hops: HopRecord[] = []

  constructor(
    private readonly registry: AgentRegistry,
    private readonly sessionId: string,
  ) {}

  get hopCount(): number {
    return this.hops.length
  }

  /**
   * Request a handoff from `currentAgentId` to `targetAgentId`.
   * Validates the handoff against the cycle config and records it.
   *
   * @throws CycleEngineError if the handoff is not allowed
   */
  async requestHandoff(
    currentAgentId: string,
    targetAgentId: string,
    context: Omit<CycleRoutingContext, 'currentAgentId' | 'hopCount' | 'sessionId'>,
  ): Promise<string> {
    const agent = this.registry.get(currentAgentId)
    const config: CycleConfig = agent.cycle ?? {}
    const maxHops = config.maxHops ?? 10

    // Check max hops
    if (this.hops.length >= maxHops) {
      throw new CycleEngineError(
        `[Roy] Max hops (${maxHops}) reached for session ${this.sessionId}. Last agent: ${currentAgentId}.`,
        'MAX_HOPS',
      )
    }

    // Check allowlist
    if (config.allowedHandoffTargets && !config.allowedHandoffTargets.includes(targetAgentId)) {
      throw new CycleEngineError(
        `[Roy] Agent "${currentAgentId}" is not allowed to hand off to "${targetAgentId}". ` +
          `Allowed targets: ${config.allowedHandoffTargets.join(', ')}`,
        'DISALLOWED_TARGET',
      )
    }

    // Check target exists
    if (!this.registry.has(targetAgentId)) {
      throw new CycleEngineError(
        `[Roy] Handoff target "${targetAgentId}" is not a registered agent.`,
        'DISALLOWED_TARGET',
      )
    }

    // Dynamic routing override
    if (config.routingFn) {
      const routingContext: CycleRoutingContext = {
        currentAgentId,
        hopCount: this.hops.length,
        sessionId: this.sessionId,
        ...context,
      }
      const override = await config.routingFn(routingContext)
      if (override) {
        targetAgentId = override
      }
    }

    // Loop detection: check if this exact path has been seen
    const loopDetected = this.hops.some(
      (h) => h.fromAgentId === targetAgentId && h.toAgentId === currentAgentId,
    )

    if (loopDetected) {
      const strategy = config.loopStrategy ?? 'break'
      switch (strategy) {
        case 'break':
          throw new CycleEngineError(
            `[Roy] Cycle detected: ${currentAgentId} → ${targetAgentId} was already visited in reverse. Stopping.`,
            'LOOP_DETECTED',
          )
        case 'retry':
          // Signal that the orchestrator should retry the current agent
          return currentAgentId
        case 'escalate': {
          // Find the next available agent in the registry that hasn't been visited
          const visitedIds = new Set(this.hops.flatMap((h) => [h.fromAgentId, h.toAgentId]))
          const nextAgent = this.registry.all().find((a) => !visitedIds.has(a.id))
          if (!nextAgent) {
            throw new CycleEngineError(
              `[Roy] Cycle detected and no unvisited agents available for escalation.`,
              'LOOP_DETECTED',
            )
          }
          targetAgentId = nextAgent.id
          break
        }
      }
    }

    // Cooldown
    if (config.hopCooldownMs && config.hopCooldownMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.hopCooldownMs))
    }

    this.hops.push({
      fromAgentId: currentAgentId,
      toAgentId: targetAgentId,
      hopNumber: this.hops.length + 1,
      timestamp: new Date().toISOString(),
    })

    return targetAgentId
  }

  getHistory(): HopRecord[] {
    return [...this.hops]
  }

  reset(): void {
    this.hops = []
  }
}
