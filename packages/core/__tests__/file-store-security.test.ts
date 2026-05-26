import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { FileStore } from '../src/session/stores/file-store.js'
import type { ChatSession } from '../src/types/session.js'

function session(id: string): ChatSession {
  return {
    id,
    agentId: 'assistant',
    status: 'active',
    messages: [],
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
    createdAt: '2026-05-26T00:00:00Z',
    updatedAt: '2026-05-26T00:00:00Z',
  }
}

describe('FileStore security', () => {
  it('rejects unsafe session IDs so callers cannot traverse out of the store directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roy-filestore-'))
    const store = new FileStore(directory)

    await expect(store.save(session('../outside'))).rejects.toThrow('Invalid session ID')
    await expect(store.load('../outside')).resolves.toBeUndefined()
    await expect(store.delete('../outside')).resolves.toBeUndefined()

    await rm(directory, { recursive: true, force: true })
  })
})
