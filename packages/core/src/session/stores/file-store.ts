import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageAdapter, ChatSession } from '../../types/session.js'

/**
 * File-based session store. Persists each session as a JSON file.
 * Good for CLI tools, scripts, and single-process servers.
 *
 * @example
 * ```ts
 * const store = new FileStore('./roy-sessions')
 * ```
 */
export class FileStore<TInput = unknown, TOutput = unknown> implements StorageAdapter<
  TInput,
  TOutput
> {
  constructor(private readonly directory: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  private filePath(sessionId: string): string {
    return join(this.directory, `${sessionId}.json`)
  }

  async save(session: ChatSession<TInput, TOutput>): Promise<void> {
    await this.ensureDir()
    await writeFile(this.filePath(session.id), JSON.stringify(session, null, 2), 'utf-8')
  }

  async load(sessionId: string): Promise<ChatSession<TInput, TOutput> | undefined> {
    try {
      const raw = await readFile(this.filePath(sessionId), 'utf-8')
      return JSON.parse(raw) as ChatSession<TInput, TOutput>
    } catch {
      return undefined
    }
  }

  async list(agentId?: string): Promise<ChatSession<TInput, TOutput>[]> {
    await this.ensureDir()
    let files: string[]
    try {
      files = await readdir(this.directory)
    } catch {
      return []
    }

    const sessions: ChatSession<TInput, TOutput>[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.directory, file), 'utf-8')
        const session = JSON.parse(raw) as ChatSession<TInput, TOutput>
        if (!agentId || session.agentId === agentId) {
          sessions.push(session)
        }
      } catch {
        // skip corrupt files
      }
    }

    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionId))
    } catch {
      // file may not exist
    }
  }
}
