import type { StorageAdapter, ChatSession } from '@chatroy/core'
import type { MemoryStorageAdapter, MemoryEntry, GlobalMemory } from '@chatroy/core'

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export type VectorMetric = 'cosine' | 'l2' | 'innerProduct'
export type PgVectorIndexType = 'hnsw' | 'ivfflat'

// ─── pgvector search store ───────────────────────────────────────────────────

export interface PgVectorIndexConfig {
  /**
   * Vector index type. HNSW is usually a better default on modern pgvector
   * installs; IVFFlat is available on older versions.
   */
  type: PgVectorIndexType
  /** Distance metric used by the index and search queries. Default: 'cosine'. */
  metric?: VectorMetric
  /** IVFFlat list count. PostgreSQL default is used when omitted. */
  lists?: number
  /** HNSW graph degree. PostgreSQL default is used when omitted. */
  m?: number
  /** HNSW build-time candidate list size. PostgreSQL default is used when omitted. */
  efConstruction?: number
}

export interface PgVectorStoreConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** Table name for embedded documents. Default: 'roy_vectors' */
  tableName?: string
  /** Embedding dimensionality, for example 1536 for text-embedding-3-small. */
  embeddingDimensions: number
  /** Auto-create the extension/table/index on first use. Default: true */
  autoMigrate?: boolean
  /** Run CREATE EXTENSION IF NOT EXISTS vector during migration. Default: true */
  createExtension?: boolean
  /**
   * Optional approximate-nearest-neighbor index. Set to false to skip index
   * creation and use exact scans.
   */
  index?: PgVectorIndexConfig | false
}

export interface PgVectorDocument {
  id: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
  sourceSessionId?: string
  sourceMessageId?: string
  createdAt?: string
  updatedAt?: string
}

export interface PgVectorSearchOptions {
  embedding: number[]
  /** Number of results to return. Default: 10 */
  limit?: number
  /** Distance metric for this query. Default: store/index metric, then cosine. */
  metric?: VectorMetric
  /** Include stored embedding vectors in results. Default: false */
  includeEmbedding?: boolean
  /** JSONB containment filter applied to metadata. */
  metadata?: Record<string, unknown>
  sourceSessionId?: string
  sourceMessageId?: string
}

export interface PgVectorSearchResult extends Omit<PgVectorDocument, 'embedding'> {
  embedding?: number[]
  /** Raw pgvector distance. Lower is better. */
  distance: number
  /**
   * Convenience score where higher is better.
   * Cosine uses 1 - distance; L2 and inner product use -distance.
   */
  score: number
}

/**
 * pgvector-backed embedding store.
 *
 * Stores arbitrary text chunks plus their embedding vectors and metadata, then
 * searches them with pgvector distance operators.
 *
 * @example
 * ```ts
 * import { PgVectorStore } from '@chatroy/pgvector'
 *
 * const vectors = new PgVectorStore({
 *   connectionString: process.env.DATABASE_URL!,
 *   embeddingDimensions: 1536,
 *   index: { type: 'hnsw', metric: 'cosine' },
 * })
 *
 * await vectors.upsert({
 *   id: 'msg_123',
 *   content: 'The user prefers concise answers.',
 *   embedding,
 *   metadata: { kind: 'preference' },
 * })
 *
 * const results = await vectors.search({ embedding: queryEmbedding, limit: 5 })
 * ```
 */
export class PgVectorStore {
  private pool: import('pg').Pool | null = null
  private readonly tableName: string
  private readonly vectorIndexName: string
  private readonly metadataIndexName: string
  private readonly sessionIndexName: string
  private readonly messageIndexName: string
  private readonly connectionString: string
  private readonly autoMigrate: boolean
  private readonly createExtension: boolean
  private readonly dimensions: number
  private readonly index: PgVectorIndexConfig | false
  private migrated = false
  private migrationPromise: Promise<void> | null = null

  constructor(config: PgVectorStoreConfig) {
    this.connectionString = config.connectionString
    const tableName = validateSqlIdentifier(config.tableName ?? 'roy_vectors', 'tableName')
    this.tableName = quoteSqlIdentifier(tableName)
    this.vectorIndexName = quoteSqlIdentifier(`${tableName}_embedding_idx`)
    this.metadataIndexName = quoteSqlIdentifier(`${tableName}_metadata_idx`)
    this.sessionIndexName = quoteSqlIdentifier(`${tableName}_source_session_id_idx`)
    this.messageIndexName = quoteSqlIdentifier(`${tableName}_source_message_id_idx`)
    this.autoMigrate = config.autoMigrate ?? true
    this.createExtension = config.createExtension ?? true
    this.dimensions = validateDimensions(config.embeddingDimensions)
    this.index = config.index === false ? false : validateIndexConfig(config.index)
  }

  private async getPool(): Promise<import('pg').Pool> {
    const pool = await this.getPoolWithoutMigration()
    if (this.autoMigrate) await this.ensureMigrated()
    return pool
  }

  private async getPoolWithoutMigration(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool
    try {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.connectionString })
      return this.pool
    } catch {
      throw new Error('[Roy] pg is required for PgVectorStore. Run: npm install pg')
    }
  }

  /**
   * Create the pgvector extension, table, metadata indexes, and optional vector
   * ANN index. Call manually when autoMigrate is false.
   */
  async migrate(): Promise<void> {
    await this.ensureMigrated()
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigration()
        .then(() => {
          this.migrated = true
        })
        .catch((error) => {
          this.migrationPromise = null
          throw error
        })
    }
    await this.migrationPromise
  }

  private async runMigration(): Promise<void> {
    const pool = this.pool ?? (await this.getPoolWithoutMigration())
    if (this.createExtension) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding vector(${this.dimensions}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        source_session_id TEXT,
        source_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ${this.metadataIndexName}
        ON ${this.tableName} USING GIN (metadata);

      CREATE INDEX IF NOT EXISTS ${this.sessionIndexName}
        ON ${this.tableName} (source_session_id);

      CREATE INDEX IF NOT EXISTS ${this.messageIndexName}
        ON ${this.tableName} (source_message_id);
    `)

    if (this.index) {
      await pool.query(createVectorIndexSql(this.tableName, this.vectorIndexName, this.index))
    }
  }

  async upsert(document: PgVectorDocument): Promise<void> {
    validateVector(document.embedding, this.dimensions, 'document.embedding')
    const pool = await this.getPool()
    await pool.query(
      `INSERT INTO ${this.tableName}
         (id, content, embedding, metadata, source_session_id, source_message_id, created_at, updated_at)
       VALUES (
         $1,
         $2,
         $3::vector,
         $4::jsonb,
         $5,
         $6,
         COALESCE($7::timestamptz, NOW()),
         COALESCE($8::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE
         SET content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata,
             source_session_id = EXCLUDED.source_session_id,
             source_message_id = EXCLUDED.source_message_id,
             updated_at = EXCLUDED.updated_at`,
      [
        document.id,
        document.content,
        vectorLiteral(document.embedding, this.dimensions),
        JSON.stringify(document.metadata ?? {}),
        document.sourceSessionId ?? null,
        document.sourceMessageId ?? null,
        document.createdAt ?? null,
        document.updatedAt ?? null,
      ],
    )
  }

  async upsertMany(documents: PgVectorDocument[]): Promise<void> {
    if (documents.length === 0) return
    const pool = await this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const document of documents) {
        validateVector(document.embedding, this.dimensions, 'document.embedding')
        await client.query(
          `INSERT INTO ${this.tableName}
             (id, content, embedding, metadata, source_session_id, source_message_id, created_at, updated_at)
           VALUES (
             $1,
             $2,
             $3::vector,
             $4::jsonb,
             $5,
             $6,
             COALESCE($7::timestamptz, NOW()),
             COALESCE($8::timestamptz, NOW())
           )
           ON CONFLICT (id) DO UPDATE
             SET content = EXCLUDED.content,
                 embedding = EXCLUDED.embedding,
                 metadata = EXCLUDED.metadata,
                 source_session_id = EXCLUDED.source_session_id,
                 source_message_id = EXCLUDED.source_message_id,
                 updated_at = EXCLUDED.updated_at`,
          [
            document.id,
            document.content,
            vectorLiteral(document.embedding, this.dimensions),
            JSON.stringify(document.metadata ?? {}),
            document.sourceSessionId ?? null,
            document.sourceMessageId ?? null,
            document.createdAt ?? null,
            document.updatedAt ?? null,
          ],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async search(options: PgVectorSearchOptions): Promise<PgVectorSearchResult[]> {
    validateVector(options.embedding, this.dimensions, 'options.embedding')
    const metric = validateMetric(
      options.metric ?? (this.index ? this.index.metric : undefined) ?? 'cosine',
      'options.metric',
    )
    const operator = vectorOperator(metric)
    const where: string[] = []
    const values: unknown[] = [vectorLiteral(options.embedding, this.dimensions)]

    if (options.metadata !== undefined) {
      values.push(JSON.stringify(options.metadata))
      where.push(`metadata @> $${values.length}::jsonb`)
    }
    if (options.sourceSessionId !== undefined) {
      values.push(options.sourceSessionId)
      where.push(`source_session_id = $${values.length}`)
    }
    if (options.sourceMessageId !== undefined) {
      values.push(options.sourceMessageId)
      where.push(`source_message_id = $${values.length}`)
    }

    const limit = validateLimit(options.limit ?? 10)
    values.push(limit)
    const limitPlaceholder = `$${values.length}`
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const embeddingSelect = options.includeEmbedding ? ', embedding::text AS embedding' : ''
    const pool = await this.getPool()
    const result = await pool.query(
      `SELECT
         id,
         content,
         metadata,
         source_session_id,
         source_message_id,
         created_at,
         updated_at,
         embedding ${operator} $1::vector AS distance
         ${embeddingSelect}
       FROM ${this.tableName}
       ${whereSql}
       ORDER BY embedding ${operator} $1::vector ASC
       LIMIT ${limitPlaceholder}`,
      values,
    )

    return result.rows.map((row) => {
      const distance = Number(row.distance)
      const match: PgVectorSearchResult = {
        id: row.id,
        content: row.content,
        metadata: row.metadata,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        distance,
        score: scoreFromDistance(distance, metric),
      }
      if (row.source_session_id != null) match.sourceSessionId = row.source_session_id
      if (row.source_message_id != null) match.sourceMessageId = row.source_message_id
      if (options.includeEmbedding) match.embedding = parseVector(row.embedding)
      return match
    })
  }

  async delete(id: string): Promise<void> {
    const pool = await this.getPool()
    await pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id])
  }

  async deleteBySession(sourceSessionId: string): Promise<void> {
    const pool = await this.getPool()
    await pool.query(`DELETE FROM ${this.tableName} WHERE source_session_id = $1`, [
      sourceSessionId,
    ])
  }

  async close(): Promise<void> {
    await this.pool?.end()
    this.pool = null
  }
}

// ─── PostgreSQL session store ─────────────────────────────────────────────────

export interface PgSessionStoreConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** Table name for sessions. Default: 'roy_sessions' */
  tableName?: string
  /** Auto-create the table on first use. Default: true */
  autoMigrate?: boolean
}

/**
 * PostgreSQL-backed session store.
 * Stores sessions as JSONB. Use PgVectorStore alongside this adapter for
 * embedding-backed retrieval over selected messages or documents.
 *
 * Roy auto-creates the sessions table on first use (if autoMigrate: true).
 *
 * @example
 * ```ts
 * import { PgSessionStore } from '@chatroy/pgvector'
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
  private readonly agentIdIndexName: string
  private readonly updatedAtIndexName: string
  private readonly connectionString: string
  private readonly autoMigrate: boolean
  private migrated = false
  private migrationPromise: Promise<void> | null = null

  constructor(config: PgSessionStoreConfig) {
    this.connectionString = config.connectionString
    const tableName = validateSqlIdentifier(config.tableName ?? 'roy_sessions', 'tableName')
    this.tableName = quoteSqlIdentifier(tableName)
    this.agentIdIndexName = quoteSqlIdentifier(`${tableName}_agent_id_idx`)
    this.updatedAtIndexName = quoteSqlIdentifier(`${tableName}_updated_at_idx`)
    this.autoMigrate = config.autoMigrate ?? true
  }

  private async getPool(): Promise<import('pg').Pool> {
    const pool = await this.getPoolWithoutMigration()
    if (this.autoMigrate) await this.ensureMigrated()
    return pool
  }

  private async getPoolWithoutMigration(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool
    try {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.connectionString })
      return this.pool
    } catch {
      throw new Error('[Roy] pg is required for PgSessionStore. Run: npm install pg @types/pg')
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigration()
        .then(() => {
          this.migrated = true
        })
        .catch((error) => {
          this.migrationPromise = null
          throw error
        })
    }
    await this.migrationPromise
  }

  private async runMigration(): Promise<void> {
    const pool = await this.getPoolWithoutMigration()
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ${this.agentIdIndexName}
        ON ${this.tableName} (agent_id);

      CREATE INDEX IF NOT EXISTS ${this.updatedAtIndexName}
        ON ${this.tableName} (updated_at DESC);
    `)
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

// ─── PostgreSQL memory store ──────────────────────────────────────────────────

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
 * import { PgMemoryStore } from '@chatroy/pgvector'
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
  private migrationPromise: Promise<void> | null = null

  constructor(config: PgMemoryStoreConfig) {
    this.connectionString = config.connectionString
    this.tableName = quoteSqlIdentifier(
      validateSqlIdentifier(config.tableName ?? 'roy_memory', 'tableName'),
    )
    this.autoMigrate = config.autoMigrate ?? true
  }

  private async getPool(): Promise<import('pg').Pool> {
    const pool = await this.getPoolWithoutMigration()
    if (this.autoMigrate) await this.ensureMigrated()
    return pool
  }

  private async getPoolWithoutMigration(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool
    try {
      const { Pool } = await import('pg')
      this.pool = new Pool({ connectionString: this.connectionString })
      return this.pool
    } catch {
      throw new Error('[Roy] pg is required for PgMemoryStore. Run: npm install pg')
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigration()
        .then(() => {
          this.migrated = true
        })
        .catch((error) => {
          this.migrationPromise = null
          throw error
        })
    }
    await this.migrationPromise
  }

  private async runMigration(): Promise<void> {
    const pool = await this.getPoolWithoutMigration()
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        slot_name TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        source_session_ids TEXT[] NOT NULL DEFAULT '{}',
        source_message_ids TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
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

function validateSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`[Roy] Invalid PostgreSQL ${label}: "${value}".`)
  }
  return value
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function validateDimensions(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[Roy] embeddingDimensions must be a positive integer. Received: ${value}.`)
  }
  return value
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[Roy] search limit must be a positive integer. Received: ${value}.`)
  }
  return value
}

function validateIndexConfig(index: PgVectorIndexConfig | undefined): PgVectorIndexConfig | false {
  if (index === undefined) return false
  const type = validateIndexType(index.type)
  const config: PgVectorIndexConfig = { type }
  if (index.metric !== undefined) config.metric = validateMetric(index.metric, 'index.metric')
  if (index.lists !== undefined && (!Number.isInteger(index.lists) || index.lists <= 0)) {
    throw new Error(`[Roy] PgVectorIndexConfig.lists must be a positive integer.`)
  }
  if (index.m !== undefined && (!Number.isInteger(index.m) || index.m <= 0)) {
    throw new Error(`[Roy] PgVectorIndexConfig.m must be a positive integer.`)
  }
  if (
    index.efConstruction !== undefined &&
    (!Number.isInteger(index.efConstruction) || index.efConstruction <= 0)
  ) {
    throw new Error(`[Roy] PgVectorIndexConfig.efConstruction must be a positive integer.`)
  }

  if (type === 'hnsw' && index.lists !== undefined) {
    throw new Error(`[Roy] PgVectorIndexConfig.lists only applies to ivfflat indexes.`)
  }
  if (type === 'ivfflat' && index.m !== undefined) {
    throw new Error(`[Roy] PgVectorIndexConfig.m only applies to hnsw indexes.`)
  }
  if (type === 'ivfflat' && index.efConstruction !== undefined) {
    throw new Error(`[Roy] PgVectorIndexConfig.efConstruction only applies to hnsw indexes.`)
  }

  if (index.lists !== undefined) config.lists = index.lists
  if (index.m !== undefined) config.m = index.m
  if (index.efConstruction !== undefined) config.efConstruction = index.efConstruction
  return config
}

function validateIndexType(value: unknown): PgVectorIndexType {
  if (value === 'hnsw' || value === 'ivfflat') return value
  throw new Error(`[Roy] PgVectorIndexConfig.type must be "hnsw" or "ivfflat".`)
}

function validateMetric(value: unknown, label: string): VectorMetric {
  if (value === 'cosine' || value === 'l2' || value === 'innerProduct') return value
  throw new Error(`[Roy] ${label} must be "cosine", "l2", or "innerProduct".`)
}

function validateVector(value: number[], dimensions: number, label: string): void {
  if (value.length !== dimensions) {
    throw new Error(
      `[Roy] ${label} must have exactly ${dimensions} dimensions. Received: ${value.length}.`,
    )
  }
  for (const [index, number] of value.entries()) {
    if (!Number.isFinite(number)) {
      throw new Error(`[Roy] ${label}[${index}] must be a finite number.`)
    }
  }
}

function vectorLiteral(value: number[], dimensions: number): string {
  validateVector(value, dimensions, 'embedding')
  return `[${value.join(',')}]`
}

function parseVector(value: string): number[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const body = trimmed.slice(1, -1)
  if (body.length === 0) return []
  return body.split(',').map((part) => Number(part))
}

function vectorOperator(metric: VectorMetric): '<=>' | '<->' | '<#>' {
  if (metric === 'cosine') return '<=>'
  if (metric === 'l2') return '<->'
  return '<#>'
}

function vectorOperatorClass(metric: VectorMetric): string {
  if (metric === 'cosine') return 'vector_cosine_ops'
  if (metric === 'l2') return 'vector_l2_ops'
  return 'vector_ip_ops'
}

function scoreFromDistance(distance: number, metric: VectorMetric): number {
  if (metric === 'cosine') return 1 - distance
  return -distance
}

function createVectorIndexSql(
  tableName: string,
  indexName: string,
  index: PgVectorIndexConfig,
): string {
  const metric = index.metric ?? 'cosine'
  const operatorClass = vectorOperatorClass(metric)
  if (index.type === 'hnsw') {
    const options = []
    if (index.m !== undefined) options.push(`m = ${index.m}`)
    if (index.efConstruction !== undefined) {
      options.push(`ef_construction = ${index.efConstruction}`)
    }
    const withSql = options.length > 0 ? ` WITH (${options.join(', ')})` : ''
    return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING hnsw (embedding ${operatorClass})${withSql}`
  }

  const withSql = index.lists !== undefined ? ` WITH (lists = ${index.lists})` : ''
  return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING ivfflat (embedding ${operatorClass})${withSql}`
}
