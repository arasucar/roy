import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgVectorStore } from '../src/index.js'

const pgState = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((innerResolve) => {
      resolve = innerResolve
    })
    return { promise, resolve }
  }

  const tableStarted = deferred()
  return {
    instances: [] as FakePool[],
    failNextMigration: false,
    holdTableMigration: false,
    migrationFinished: false,
    queriesBeforeMigration: 0,
    extensionCalls: 0,
    tableCalls: 0,
    releaseTableMigration: undefined as (() => void) | undefined,
    tableMigrationStarted: tableStarted.promise,
    resolveTableMigrationStarted: tableStarted.resolve,
    reset() {
      const nextTableStarted = deferred()
      this.instances = []
      this.failNextMigration = false
      this.holdTableMigration = false
      this.migrationFinished = false
      this.queriesBeforeMigration = 0
      this.extensionCalls = 0
      this.tableCalls = 0
      this.releaseTableMigration = undefined
      this.tableMigrationStarted = nextTableStarted.promise
      this.resolveTableMigrationStarted = nextTableStarted.resolve
    },
  }
})

class FakePool {
  queries: Array<{ text: string; values?: unknown[] }> = []

  constructor() {
    pgState.instances.push(this)
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push(values === undefined ? { text } : { text, values })

    if (text.includes('CREATE EXTENSION')) {
      pgState.extensionCalls += 1
      if (pgState.failNextMigration) {
        pgState.failNextMigration = false
        throw new Error('migration failed')
      }
      return { rows: [] }
    }

    if (text.includes('CREATE TABLE IF NOT EXISTS')) {
      pgState.tableCalls += 1
      pgState.resolveTableMigrationStarted()
      if (pgState.holdTableMigration) {
        await new Promise<void>((resolve) => {
          pgState.releaseTableMigration = resolve
        })
      }
      pgState.migrationFinished = true
      return { rows: [] }
    }

    if (!text.includes('CREATE INDEX') && !pgState.migrationFinished) {
      pgState.queriesBeforeMigration += 1
    }

    return { rows: [] }
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    }
  }

  async end() {}
}

vi.mock('pg', () => ({ Pool: FakePool }))

describe('PgVectorStore', () => {
  beforeEach(() => {
    pgState.reset()
  })

  it('shares one migration across concurrent first-use queries', async () => {
    pgState.holdTableMigration = true
    const store = new PgVectorStore({
      connectionString: 'postgres://example',
      embeddingDimensions: 3,
      index: false,
    })

    const searchPromise = store.search({ embedding: [0, 0, 1] })
    await pgState.tableMigrationStarted

    const upsertPromise = store.upsert({
      id: 'doc_1',
      content: 'hello',
      embedding: [0, 0, 1],
    })

    await Promise.resolve()
    expect(pgState.tableCalls).toBe(1)
    expect(pgState.queriesBeforeMigration).toBe(0)

    pgState.releaseTableMigration?.()
    await expect(Promise.all([searchPromise, upsertPromise])).resolves.toBeDefined()

    expect(pgState.instances).toHaveLength(1)
    expect(pgState.extensionCalls).toBe(1)
    expect(pgState.tableCalls).toBe(1)
  })

  it('retries migration after a failed first attempt', async () => {
    pgState.failNextMigration = true
    const store = new PgVectorStore({
      connectionString: 'postgres://example',
      embeddingDimensions: 3,
      index: false,
    })

    await expect(store.search({ embedding: [0, 0, 1] })).rejects.toThrow('migration failed')
    await expect(store.search({ embedding: [0, 0, 1] })).resolves.toEqual([])

    expect(pgState.instances).toHaveLength(1)
    expect(pgState.extensionCalls).toBe(2)
    expect(pgState.tableCalls).toBe(1)
  })

  it('rejects invalid runtime vector config instead of falling back silently', async () => {
    expect(
      () =>
        new PgVectorStore({
          connectionString: 'postgres://example',
          embeddingDimensions: 3,
          index: { type: 'bad' as never },
        }),
    ).toThrow('PgVectorIndexConfig.type')

    expect(
      () =>
        new PgVectorStore({
          connectionString: 'postgres://example',
          embeddingDimensions: 3,
          index: { type: 'hnsw', metric: 'dot' as never },
        }),
    ).toThrow('index.metric')

    const store = new PgVectorStore({
      connectionString: 'postgres://example',
      embeddingDimensions: 3,
      autoMigrate: false,
      index: false,
    })

    await expect(store.search({ embedding: [0, 0, 1], metric: 'dot' as never })).rejects.toThrow(
      'options.metric',
    )
    expect(pgState.instances).toHaveLength(0)
  })
})
