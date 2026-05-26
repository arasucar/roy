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
    // Parentheses required — `+` binds tighter than `??` without them
    const tokenDelta = (message.cost?.promptTokens ?? 0) + (message.cost?.completionTokens ?? 0)
    const updated: ChatSession<TInput, TOutput> = {
      ...session,
      messages: [...session.messages, message],
      cumulativeTokens: session.cumulativeTokens + tokenDelta,
      cumulativeCostUsd: session.cumulativeCostUsd + (message.cost?.estimatedCostUsd ?? 0),
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
