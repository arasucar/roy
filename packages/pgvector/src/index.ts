import type { StorageAdapter, ChatSession } from '@roy/core'
import type { MemoryStorageAdapter, MemoryEntry, GlobalMemory } from '@roy/core'

// ─── pgvector session store ───────────────────────────────────────────────────

export interface PgSessionStoreConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** Table name for sessions. Default: 'roy_sessions' */
  tableName?: string
  /** Auto-create the table on first use. Default: true */
  autoMigrate?: boolean
}

/**
 * PostgreSQL-backed session store using pgvector.
 * Stores sessions as JSONB. Enables semantic search over session history.
 *
 * Setup:
 * ```sql
 * CREATE EXTENSION IF NOT EXISTS vector;
 * ```
 *
 * Roy auto-creates the sessions table on first use (if autoMigrate: true).
 *
 * @example
 * ```ts
 * import { PgSessionStore } from '@roy/pgvector'
 *
 * const store = new PgSessionStore({
 *   connectionString: process.env.DATABASE_URL!,
 * })
 *
 * const roy = createChat({ agents, store })
 * ```
 */
export class PgSessionStore<TInput = unknown, TOutput = unknown> implements StorageAdapter<
  TInput,
  TOutput
> {
  private pool: import('pg').Pool | null = null
  private readonly tableName: string
  private readonly connectionString: string
  private readonly autoMigrate: boolean
  private migrated = false

  constructor(config: PgSessionStoreConfig) {
    this.connectionString = config.connectionString
    this.tableName = config.tableName ?? 'roy_sessions'
    this.autoMigrate = config.autoMigrate ?? true
  }

  private async getPool(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool
    try {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.connectionString })
    } catch {
      throw new Error('[Roy] pg is required for PgSessionStore. Run: npm install pg @types/pg')
    }
    if (this.autoMigrate && !this.migrated) {
      await this.migrate()
    }
    return this.pool
  }

  private async migrate(): Promise<void> {
    const pool = this.pool!
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ${this.tableName}_agent_id_idx
        ON ${this.tableName} (agent_id);

      CREATE INDEX IF NOT EXISTS ${this.tableName}_updated_at_idx
        ON ${this.tableName} (updated_at DESC);
    `)
    this.migrated = true
  }

  async save(session: ChatSession<TInput, TOutput>): Promise<void> {
    const pool = await this.getPool()
    await pool.query(
      `INSERT INTO ${this.tableName} (id, agent_id, status, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             status = EXCLUDED.status,
             updated_at = NOW()`,
      [session.id, session.agentId, session.status, JSON.stringify(session)],
    )
  }

  async load(sessionId: string): Promise<ChatSession<TInput, TOutput> | undefined> {
    const pool = await this.getPool()
    const result = await pool.query(`SELECT data FROM ${this.tableName} WHERE id = $1`, [sessionId])
    if (!result.rows[0]) return undefined
    return result.rows[0].data as ChatSession<TInput, TOutput>
  }

  async list(agentId?: string): Promise<ChatSession<TInput, TOutput>[]> {
    const pool = await this.getPool()
    const result = agentId
      ? await pool.query(
          `SELECT data FROM ${this.tableName} WHERE agent_id = $1 ORDER BY updated_at DESC`,
          [agentId],
        )
      : await pool.query(`SELECT data FROM ${this.tableName} ORDER BY updated_at DESC`)
    return result.rows.map((r) => r.data as ChatSession<TInput, TOutput>)
  }

  async delete(sessionId: string): Promise<void> {
    const pool = await this.getPool()
    await pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [sessionId])
  }

  async close(): Promise<void> {
    await this.pool?.end()
    this.pool = null
  }
}

// ─── pgvector memory store ────────────────────────────────────────────────────

export interface PgMemoryStoreConfig {
  connectionString: string
  /** Table name for memory entries. Default: 'roy_memory' */
  tableName?: string
  autoMigrate?: boolean
}

/**
 * PostgreSQL-backed global memory store.
 * Persists memory slots as JSONB entries.
 *
 * @example
 * ```ts
 * import { PgMemoryStore } from '@roy/pgvector'
 *
 * const roy = createChat({
 *   agents,
 *   memory: {
 *     schema: memorySchema,
 *     store: new PgMemoryStore({ connectionString: process.env.DATABASE_URL! }),
 *   },
 * })
 * ```
 */
export class PgMemoryStore implements MemoryStorageAdapter {
  private pool: import('pg').Pool | null = null
  private readonly tableName: string
  private readonly connectionString: string
  private readonly autoMigrate: boolean
  private migrated = false

  constructor(config: PgMemoryStoreConfig) {
    this.connectionString = config.connectionString
    this.tableName = config.tableName ?? 'roy_memory'
    this.autoMigrate = config.autoMigrate ?? true
  }

  private async getPool(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool
    try {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.connectionString })
    } catch {
      throw new Error('[Roy] pg is required for PgMemoryStore. Run: npm install pg')
    }
    if (this.autoMigrate && !this.migrated) {
      await this.migrate()
    }
    return this.pool
  }

  private async migrate(): Promise<void> {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        slot_name TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        source_session_ids TEXT[] NOT NULL DEFAULT '{}',
        source_message_ids TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    this.migrated = true
  }

  async load(): Promise<GlobalMemory> {
    const pool = await this.getPool()
    const result = await pool.query(`SELECT * FROM ${this.tableName}`)
    const entries = new Map<string, MemoryEntry>()
    for (const row of result.rows) {
      entries.set(row.slot_name, {
        slotName: row.slot_name,
        value: row.value,
        sourceSessionIds: row.source_session_ids,
        sourceMessageIds: row.source_message_ids,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })
    }
    return { entries }
  }

  async save(memory: GlobalMemory): Promise<void> {
    for (const [slotName, entry] of memory.entries) {
      await this.setSlot(slotName, entry)
    }
  }

  async getSlot(slotName: string): Promise<MemoryEntry | undefined> {
    const pool = await this.getPool()
    const result = await pool.query(`SELECT * FROM ${this.tableName} WHERE slot_name = $1`, [
      slotName,
    ])
    if (!result.rows[0]) return undefined
    const row = result.rows[0]
    return {
      slotName: row.slot_name,
      value: row.value,
      sourceSessionIds: row.source_session_ids,
      sourceMessageIds: row.source_message_ids,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  }

  async setSlot(slotName: string, entry: MemoryEntry): Promise<void> {
    const pool = await this.getPool()
    await pool.query(
      `INSERT INTO ${this.tableName}
         (slot_name, value, source_session_ids, source_message_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (slot_name) DO UPDATE
         SET value = EXCLUDED.value,
             source_session_ids = EXCLUDED.source_session_ids,
             source_message_ids = EXCLUDED.source_message_ids,
             updated_at = NOW()`,
      [
        slotName,
        JSON.stringify(entry.value),
        entry.sourceSessionIds,
        entry.sourceMessageIds,
        entry.createdAt,
      ],
    )
  }

  async close(): Promise<void> {
    await this.pool?.end()
    this.pool = null
  }
}
