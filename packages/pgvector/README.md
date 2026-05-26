# @chatroy/pgvector

PostgreSQL and pgvector storage adapters for Roy.

This package includes:

- `PgSessionStore`: JSONB-backed Roy session persistence.
- `PgMemoryStore`: JSONB-backed structured memory persistence.
- `PgVectorStore`: pgvector-backed embedding storage and similarity search.

Session and structured memory stores intentionally remain JSONB stores. Use
`PgVectorStore` alongside them for retrieval over selected messages, summaries,
documents, or memory entries.

## Install

```bash
pnpm add @chatroy/pgvector @chatroy/core pg
```

`PgVectorStore` requires the PostgreSQL
[`pgvector`](https://github.com/pgvector/pgvector) extension to be available in
your database. By default it runs `CREATE EXTENSION IF NOT EXISTS vector` during
auto-migration.

## Session Store

```ts
import { createChat } from '@chatroy/core'
import { PgSessionStore } from '@chatroy/pgvector'

const roy = createChat({
  agents,
  store: new PgSessionStore({
    connectionString: process.env.DATABASE_URL!,
  }),
})
```

## Memory Store

```ts
import { PgMemoryStore } from '@chatroy/pgvector'

const memoryStore = new PgMemoryStore({
  connectionString: process.env.DATABASE_URL!,
})
```

## Vector Store

```ts
import { PgVectorStore } from '@chatroy/pgvector'

const vectors = new PgVectorStore({
  connectionString: process.env.DATABASE_URL!,
  embeddingDimensions: 1536,
  index: {
    type: 'hnsw',
    metric: 'cosine',
  },
})

await vectors.upsert({
  id: 'msg_123',
  content: 'The user prefers concise answers.',
  embedding,
  metadata: {
    kind: 'preference',
  },
  sourceSessionId: 'session_123',
  sourceMessageId: 'message_123',
})

const matches = await vectors.search({
  embedding: queryEmbedding,
  limit: 5,
  metadata: {
    kind: 'preference',
  },
})

for (const match of matches) {
  console.log(match.score, match.content)
}
```

`PgVectorStore` creates this table by default:

- `id TEXT PRIMARY KEY`
- `content TEXT NOT NULL`
- `embedding vector(<embeddingDimensions>) NOT NULL`
- `metadata JSONB NOT NULL DEFAULT '{}'`
- optional `source_session_id` and `source_message_id`
- `created_at` and `updated_at` timestamps

Search supports cosine, L2, and inner-product distance:

```ts
await vectors.search({
  embedding: queryEmbedding,
  metric: 'cosine',
  limit: 10,
})
```

The raw `distance` is returned with each result. A convenience `score` is also
included where higher is better.

## Security Notes

- Query values are parameterized.
- Custom table names are validated as PostgreSQL identifiers and quoted before
  interpolation.
- Embedding vectors are validated for finite numbers and exact dimensionality
  before being sent to PostgreSQL.
- Connection strings should come from server-side configuration, not browser
  bundles.

## Published Artifacts

This package intentionally publishes `dist`, `src`, declaration maps, and
JavaScript source maps.

## License

MIT
