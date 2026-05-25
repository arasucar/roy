import type { AgentDefinition } from '../types/agent.js'

/**
 * AgentRegistry — holds all agent definitions for a Roy instance.
 * Agents are registered once at `createChat()` time and looked up by ID.
 */
export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>()

  constructor(definitions: AgentDefinition[]) {
    for (const def of definitions) {
      if (this.agents.has(def.id)) {
        throw new Error(`[Roy] Duplicate agent ID: "${def.id}". Agent IDs must be unique.`)
      }
      this.agents.set(def.id, def)
    }
  }

  get(agentId: string): AgentDefinition {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(
        `[Roy] Agent "${agentId}" not found. Registered agents: ${[...this.agents.keys()].join(', ')}`,
      )
    }
    return agent
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  all(): AgentDefinition[] {
    return [...this.agents.values()]
  }

  ids(): string[] {
    return [...this.agents.keys()]
  }
}
