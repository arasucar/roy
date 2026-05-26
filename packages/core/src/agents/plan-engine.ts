import type { PlanDocument, PlanStep, PlanApprovalCallback } from '../types/agent.js'
import type { Message } from '../types/message.js'
import type { LLMProvider } from '../providers/types.js'
import { generateId } from '../utils/id.js'

const PLAN_EXTRACTION_PROMPT = `Based on the conversation so far, extract a structured execution plan.

Return a JSON object with this exact shape:
{
  "title": "Short title for the plan",
  "goal": "One sentence describing what we're trying to achieve",
  "steps": [
    {
      "order": 1,
      "title": "Step title",
      "description": "What this step does",
      "hasSideEffects": true,
      "estimatedCostUsd": { "min": 0, "max": 0.01 }
    }
  ],
  "constraints": ["Any important constraints or caveats"]
}

Return ONLY valid JSON — no markdown, no preamble.`

export type PlanModeState = 'gathering' | 'drafting' | 'pending_approval' | 'executing' | 'done'

/**
 * PlanEngine manages the plan mode state machine for a single agent session.
 *
 * State transitions:
 *   gathering → drafting → pending_approval → executing → done
 *                                          ↘ gathering (if rejected)
 *
 * The engine sits between the chat runner and the LLM:
 * - In 'gathering' state: messages pass through normally (questions only)
 * - When the host explicitly requests a plan: transition to 'drafting'
 * - 'drafting': call the LLM to emit a PlanDocument
 * - 'pending_approval': call the host's onPlanApproval callback
 * - 'executing': tools and side effects are now permitted
 */
export class PlanEngine {
  private state: PlanModeState = 'gathering'
  private plan: PlanDocument | null = null
  private gatheringMessages: Message[] = []

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly onApproval: PlanApprovalCallback,
  ) {}

  get currentState(): PlanModeState {
    return this.state
  }

  get currentPlan(): PlanDocument | null {
    return this.plan
  }

  get isExecuting(): boolean {
    return this.state === 'executing'
  }

  /**
   * Record an incoming user message so it's available for plan extraction.
   * Must be called before onAssistantMessage for each turn.
   */
  onUserMessage(message: Message): void {
    this.gatheringMessages.push(message)
  }

  /**
   * Intercept an outgoing assistant message.
   * This records context only. Plan drafting is deliberately host-driven via
   * requestPlan; Roy does not infer approval gates from assistant text.
   */
  onAssistantMessage(message: Message): void {
    this.gatheringMessages.push(message)
  }

  /**
   * Explicitly signal that gathering is complete and we should emit a plan.
   * Call this from the host app or when the user explicitly requests it.
   */
  async requestPlan(messages?: Message[]): Promise<PlanDocument> {
    if (messages !== undefined) {
      this.gatheringMessages = [...messages]
    }
    if (this.state !== 'gathering') {
      throw new Error(`[Roy] Cannot request plan in state: ${this.state}`)
    }
    return this.transitionToDrafting()
  }

  private async transitionToDrafting(): Promise<PlanDocument> {
    this.state = 'drafting'

    // Ask the LLM to extract a structured plan
    const conversationText = this.gatheringMessages
      .map((m) => {
        const text = m.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as any).text)
          .join('\n')
        return `[${m.role}]: ${text}`
      })
      .join('\n\n')

    let responseText = ''
    for await (const chunk of this.provider.stream({
      model: this.model,
      messages: [
        {
          id: generateId(),
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${PLAN_EXTRACTION_PROMPT}\n\nConversation:\n${conversationText}`,
            },
          ],
          createdAt: new Date().toISOString(),
        },
      ],
    })) {
      if (chunk.type === 'text') responseText += chunk.delta
    }

    let planData: {
      title: string
      goal: string
      steps: Omit<PlanStep, 'id'>[]
      constraints?: string[]
    }

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON found')
      planData = JSON.parse(jsonMatch[0])
    } catch {
      // Fallback: create a minimal plan
      planData = {
        title: 'Execution Plan',
        goal: 'Complete the requested task',
        steps: [
          { order: 1, title: 'Execute task', description: responseText, hasSideEffects: true },
        ],
      }
    }

    const plan: PlanDocument = {
      id: generateId(),
      sessionId: this.sessionId,
      agentId: this.agentId,
      title: planData.title,
      goal: planData.goal,
      steps: planData.steps.map((s) => ({ ...s, id: generateId() })),
      status: 'pending_approval',
      createdAt: new Date().toISOString(),
      ...(planData.constraints !== undefined ? { constraints: planData.constraints } : {}),
    }

    this.plan = plan
    this.state = 'pending_approval'

    return plan
  }

  async requestApproval(): Promise<PlanDocument | undefined> {
    if (!this.plan) return undefined

    const { approved, rejectionReason } = await this.onApproval(this.plan)

    if (approved) {
      this.plan = {
        ...this.plan,
        status: 'approved',
        approvedAt: new Date().toISOString(),
      }
      this.state = 'executing'
    } else {
      this.plan = {
        ...this.plan,
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
        ...(rejectionReason !== undefined ? { rejectionReason } : {}),
      }
      // Go back to gathering so the agent can revise
      this.state = 'gathering'
    }

    return this.plan
  }
}
