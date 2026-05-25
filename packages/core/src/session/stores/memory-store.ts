import type { StorageAdapter, ChatSession } from '../../types/session.js'

/**
 * In-process Map store. Zero config, zero persistence.
 * Use for development, testing, or single-process apps.
 */
export class MemoryStore<TInput = unknown, TOutput = unknown>
  implements StorageAdapter<TInput, TOutput>
{
  private sessions = new Map<string, ChatSession<TInput, TOutput>>()

  async save(session: ChatSession<TInput, TOutput>): Promise<void> {
    this.sessions.set(session.id, { ...session })
  }

  async load(sessionId: string): Promise<ChatSession<TInput, TOutput> | undefined> {
    return this.sessions.get(sessionId)
  }

  async list(agentId?: string): Promise<ChatSession<TInput, TOutput>[]> {
    const all = [...this.sessions.values()]
    return agentId ? all.filter((s) => s.agentId === agentId) : all
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }
}
