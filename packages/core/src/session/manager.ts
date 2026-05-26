import type { ChatSession, BranchOptions, StorageAdapter } from '../types/session.js'
import type { Message } from '../types/message.js'
import { generateId } from '../utils/id.js'

/**
 * SessionManager handles all create/load/save/branch/rollover operations.
 */
export class SessionManager<TInput = unknown, TOutput = unknown> {
  constructor(private readonly store: StorageAdapter<TInput, TOutput>) {}

  async create(options: {
    agentId: string
    label?: string
    metadata?: Record<string, unknown>
  }): Promise<ChatSession<TInput, TOutput>> {
    const now = new Date().toISOString()
    const session: ChatSession<TInput, TOutput> = {
      id: generateId(),
      agentId: options.agentId,
      status: 'active',
      messages: [],
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      createdAt: now,
      updatedAt: now,
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    }
    await this.store.save(session)
    return session
  }

  async load(sessionId: string): Promise<ChatSession<TInput, TOutput> | undefined> {
    return this.store.load(sessionId)
  }

  async save(session: ChatSession<TInput, TOutput>): Promise<void> {
    await this.store.save({ ...session, updatedAt: new Date().toISOString() })
  }

  async list(agentId?: string): Promise<ChatSession<TInput, TOutput>[]> {
    return this.store.list(agentId)
  }

  async delete(sessionId: string): Promise<void> {
    return this.store.delete(sessionId)
  }

  /**
   * Add a message to the session and update token/cost counters.
   */
  async appendMessage(
    session: ChatSession<TInput, TOutput>,
    message: Message<TInput, TOutput>,
  ): Promise<ChatSession<TInput, TOutput>> {
    const messages = [...session.messages, message]
    const updated: ChatSession<TInput, TOutput> = {
      ...session,
      messages,
      cumulativeTokens: estimateMessageTokens(messages),
      cumulativeCostUsd: session.cumulativeCostUsd + (message.cost?.estimatedCostUsd ?? 0),
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(updated)
    return updated
  }

  async updateTokenBudget(
    session: ChatSession<TInput, TOutput>,
    cumulativeTokens: number,
  ): Promise<ChatSession<TInput, TOutput>> {
    const updated: ChatSession<TInput, TOutput> = {
      ...session,
      cumulativeTokens: Math.max(0, Math.ceil(cumulativeTokens)),
      updatedAt: new Date().toISOString(),
    }
    await this.store.save(updated)
    return updated
  }

  /**
   * Branch the session at a specific message, creating a new child session.
   * The child contains all messages up to (and including) fromMessageId.
   */
  async branch(
    session: ChatSession<TInput, TOutput>,
    options: BranchOptions = {},
  ): Promise<ChatSession<TInput, TOutput>> {
    let messages = session.messages

    if (options.fromMessageId) {
      const idx = messages.findIndex((m) => m.id === options.fromMessageId)
      if (idx !== -1) {
        messages = messages.slice(0, idx + 1)
      }
    }

    const now = new Date().toISOString()
    const branchedSession: ChatSession<TInput, TOutput> = {
      ...session,
      id: generateId(),
      label: options.label ?? `Branch of ${session.label ?? session.id}`,
      messages,
      parentSessionId: session.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      metadata: { ...session.metadata, ...options.metadata },
    }

    await this.store.save(branchedSession)
    return branchedSession
  }

  /**
   * Mark the old session as rolled over and link it to the new session.
   * Called by RollingCompactor after creating the new session.
   */
  async markRolledOver(
    oldSession: ChatSession<TInput, TOutput>,
    newSessionId: string,
  ): Promise<void> {
    await this.store.save({
      ...oldSession,
      status: 'rolled_over',
      childSessionId: newSessionId,
      updatedAt: new Date().toISOString(),
    })
  }
}

function estimateMessageTokens(messages: Message[]): number {
  const text = messages
    .map((message) => message.content.map(serializeContentBlock).filter(Boolean).join('\n'))
    .join('\n')
  return Math.ceil(text.length / 4)
}

function serializeContentBlock(block: Message['content'][number]): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'summary':
      return block.text
    case 'tool_call':
      return `${block.toolCall.name} ${block.toolCall.arguments}`
    case 'tool_result':
      return `${block.toolResult.name} ${serializeToolResult(block.toolResult.result)}`
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
