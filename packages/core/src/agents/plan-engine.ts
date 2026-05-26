import type {
  PlanDocument,
  PlanStep,
  PlanStatus,
  PlanApprovalCallback,
} from '../types/agent.js'
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
 * - When the agent signals it has enough info: transition to 'drafting'
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
   * If the assistant's response contains a signal that it's ready to plan
   * (detected via heuristic or explicit signal token), transition to drafting.
   */
  async onAssistantMessage(message: Message): Promise<void> {
    this.gatheringMessages.push(message)

    if (this.state !== 'gathering') return

    // Detect plan-ready signal: assistant says something like
    // "I have all the information I need" or includes [PLAN_READY]
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text as string)
      .join(' ')
      .toLowerCase()

    const signals = [
      '[plan_ready]',
      'i have enough information',
      'i have all the information i need',
      "i'm ready to create the plan",
      'ready to proceed with the plan',
    ]

    const isReady = signals.some((s) => text.includes(s))
    if (isReady) {
      await this.transitionToDrafting()
    }
  }

  /**
   * Explicitly signal that gathering is complete and we should emit a plan.
   * Call this from the host app or when the user explicitly requests it.
   */
  async requestPlan(): Promise<PlanDocument> {
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
        steps: [{ order: 1, title: 'Execute task', description: responseText, hasSideEffects: true }],
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

    // Call the host's approval callback — updates this.plan and this.state in-place
    await this.requestApproval()

    // Return the updated plan (with approved/rejected status), not the stale pre-approval snapshot
    return this.plan!
  }

  private async requestApproval(): Promise<void> {
    if (!this.plan) return

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
  }
}
