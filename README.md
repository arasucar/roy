# Roy

Roy is a TypeScript chat runtime for long-lived agent conversations. It treats
context lifecycle as a first-class problem: what stays in the prompt, what gets
summarized, what becomes durable memory, when sessions roll over, what a turn
costs, and when an agent must stop for approval.

It also gives you the expected building blocks for modern LLM apps: streaming
chat, typed tools, provider adapters, handoff context primitives,
PostgreSQL-backed storage, and lightweight React components. The thesis is not
"another provider wrapper." The thesis is that useful agents need a reliable way
to manage context over time.

Roy is deliberately host-app first. You define the agents, prompts, tools,
storage, and UI surface; Roy handles the orchestration around them.

## Packages

Published npm packages use the `@chatroy/*` scope.

Current release: `0.2.0`.

| Package                                    | Purpose                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [`@chatroy/core`](./packages/core)         | Chat runtime, provider adapters, sessions, tools, compaction, memory, agents, plan mode, and cost tracking.             |
| [`@chatroy/react`](./packages/react)       | Small shadcn/Tailwind-compatible React components for chat UIs, model selection, compaction events, and plan approvals. |
| [`@chatroy/pgvector`](./packages/pgvector) | PostgreSQL JSONB stores for sessions/memory plus pgvector-backed embedding storage and similarity search.               |

## Why Roy

Most chat libraries make the first turn pleasant. Roy is built for the hundredth
turn, when the prompt is full of old tool results, the model still needs the
important decisions, and the app needs to preserve user preferences without
stuffing every prior message back into context.

Roy's compaction flow is designed around that lifecycle:

1. Estimate the active prompt budget before a turn is sent.
2. Truncate bulky tool results before spending model tokens on summarization.
3. Summarize older messages with source message IDs preserved.
4. Extract marked facts into structured memory before details leave the active
   conversation.
5. Roll over to a new session only when compaction cannot recover enough room.

Everything else in the library exists to support that loop cleanly inside a real
application.

## What You Get

- Stream responses from OpenAI, Anthropic, Gemini, OpenRouter, and Ollama.
- Define tools with Zod schemas and get validated tool arguments at runtime.
- Run multi-step tool loops and preserve intermediate tool-call/tool-result
  messages in the session.
- Keep long conversations usable with rolling compaction, summaries, cheap
  tool-output truncation, and session rollover events.
- Extract durable memory into app-defined schema slots before context is
  compacted away.
- Use plan mode to collect requirements, explicitly request a plan, and wait for
  approval before side-effecting work.
- Track per-turn token usage and estimated cost, including Anthropic prompt
  cache reads/writes.
- Swap in-memory, file, or PostgreSQL storage without changing chat code.

## Install

```bash
pnpm add @chatroy/core
```

Install only the provider SDKs your app actually uses:

```bash
pnpm add openai
pnpm add @anthropic-ai/sdk
pnpm add @google/generative-ai
```

Optional packages:

```bash
pnpm add @chatroy/react
pnpm add @chatroy/pgvector pg
```

Roy does not read environment variables directly. Your app passes API keys into
provider configs, so you can use whichever secret-management setup you prefer.

## Quick Start

```ts
import { createChat } from '@chatroy/core'

const roy = createChat({
  agents: [
    {
      id: 'assistant',
      name: 'Assistant',
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
      },
      model: 'gpt-4o-mini',
      systemPrompt: 'You are concise, practical, and kind.',
      compaction: {
        triggerFraction: 0.6,
        targetFraction: 0.4,
        summaryModel: 'gpt-4o-mini',
      },
    },
  ],
})

for await (const chunk of roy.send({ input: 'Hello from Roy' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta)
  if (chunk.type === 'done') {
    console.log('\nCost:', chunk.message.cost?.estimatedCostUsd)
  }
}
```

## Providers

Each agent chooses its own provider and model:

```ts
const agents = [
  {
    id: 'router',
    name: 'Router',
    provider: {
      type: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY!,
      appName: 'My Roy App',
    },
    model: 'openai/gpt-4o-mini',
    systemPrompt: 'Route the user to the right specialist.',
  },
  {
    id: 'local',
    name: 'Local Assistant',
    provider: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
    },
    model: 'llama3',
    systemPrompt: 'Answer using local context only.',
  },
]
```

Supported provider types are `openai`, `anthropic`, `gemini`, `openrouter`, and
`ollama`.

## Tools

Tools are plain async functions with Zod schemas:

```ts
import { createChat, defineTool } from '@chatroy/core'
import { z } from 'zod'

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    return { city, forecast: 'Sunny', temperatureC: 24 }
  },
})

const roy = createChat({
  agents: [
    {
      id: 'assistant',
      name: 'Assistant',
      provider: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
      model: 'gpt-4o-mini',
      systemPrompt: 'Use tools when they help.',
      tools: [getWeather],
    },
  ],
})
```

Roy streams tool calls, executes the matching tool, feeds tool results back to
the model, and saves the full turn history.

## Host-App Events

Roy emits stable events that host apps can use for supervision, logs, and UI:

- `agent-start` / `agent-end`
- `tool-call` / `tool-result`
- `handoff`
- `plan-ready` / `approval-requested` / `plan-approved` / `plan-rejected`
- `cost-updated`
- `done`
- `error`

These events are a runtime contract. `StreamChunk`s are still yielded for
rendering, but host apps do not need to reverse-engineer lifecycle state from
text deltas.

## Context Compaction

Roy treats context as an active budget. `cumulativeTokens` represents the
current estimated prompt size, not lifetime model usage.

The default rolling compactor:

1. Truncates old bulky tool results.
2. Summarizes older messages.
3. Extracts marked memory before compacting messages away.
4. Rolls over to a new session only when compaction cannot recover enough
   context.

Summaries preserve source message IDs and include tool calls/results so agent
state does not lose the evidence it depends on.

```ts
const roy = createChat({
  agents: [
    {
      id: 'assistant',
      name: 'Assistant',
      provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
      model: 'claude-3-5-sonnet-latest',
      systemPrompt: 'Help with long-running project work.',
      compaction: {
        watermarkTokens: 20_000,
        reserveOutputTokens: 8_192,
        maxCompactionPasses: 3,
      },
    },
  ],
})

roy.on('compacted', (event) => {
  console.log('Compacted session:', event.session.id)
})

roy.on('session-rollover', (event) => {
  console.log('Rolled over to:', event.newSessionId)
})
```

## Memory

Memory lets important facts survive compaction and session rollover. You decide
the slots, schemas, and merge strategy.

```ts
import { z } from 'zod'
import { createChat, InMemoryMemoryStore } from '@chatroy/core'

const roy = createChat({
  agents,
  memory: {
    store: new InMemoryMemoryStore(),
    schema: {
      slots: [
        {
          name: 'preferences',
          description: 'Durable user preferences.',
          schema: z.object({
            tone: z.string().optional(),
            format: z.string().optional(),
          }),
          mergeStrategy: 'merge',
        },
      ],
    },
  },
})

await roy.send({
  input: 'Please keep answers concise.',
  memoryMarker: {
    slots: ['preferences'],
    reason: 'User stated a durable response preference.',
  },
})
```

## Plan Approval

Plan mode is explicit. Roy does not watch for text like `[PLAN_READY]` or infer
approval gates from assistant prose.

```ts
roy.on('approval-requested', ({ plan }) => {
  renderApprovalModal(plan)
})

const plan = await roy.requestPlan(sessionId)

if (plan.status === 'approved') {
  await roy.send({ sessionId, input: 'Execute the approved plan.' })
}
```

The approval decision comes from the agent's `onPlanApproval` callback, which can
block on UI, policy checks, or another host-owned approval flow.

## Handoffs

Roy provides handoff validation and context packaging. It does not try to be a
durable multi-agent workflow engine.

Use Roy to choose and describe the next agent boundary; let your host app own the
workflow loop, retries, pause/resume/cancel, durable run state, event logs,
context validation, approvals, and UI supervision.

## Sessions, Storage, And Retrieval

The core package includes in-memory and file-backed session stores. The
PostgreSQL package adds JSONB-backed session and memory stores plus a pgvector
store for retrieval:

```ts
import { createChat } from '@chatroy/core'
import { PgMemoryStore, PgSessionStore, PgVectorStore } from '@chatroy/pgvector'

const vectorStore = new PgVectorStore({
  connectionString: process.env.DATABASE_URL!,
  embeddingDimensions: 1536,
  index: { type: 'hnsw', metric: 'cosine' },
})

const roy = createChat({
  agents,
  store: new PgSessionStore({
    connectionString: process.env.DATABASE_URL!,
  }),
  memory: {
    schema: memorySchema,
    store: new PgMemoryStore({
      connectionString: process.env.DATABASE_URL!,
    }),
  },
})

await vectorStore.upsert({
  id: 'summary_123',
  content: 'The user prefers concise, practical answers.',
  embedding,
  metadata: { kind: 'preference' },
})

const matches = await vectorStore.search({
  embedding: queryEmbedding,
  limit: 5,
  metadata: { kind: 'preference' },
})
```

Custom PostgreSQL table names are validated before they are interpolated, and
query values are passed through parameterized queries. `PgVectorStore` requires
the PostgreSQL `vector` extension.

## React Components

```tsx
import {
  ChatWindow,
  CompactionBanner,
  ModelPicker,
  PlanApproval,
  SessionRolloverAlert,
} from '@chatroy/react'
```

The components render shadcn/Tailwind-compatible class names and do not ship a
CSS bundle. Bring your own design tokens, app shell, and state management.

## Compared To Other Tools

Roy overlaps with several excellent projects. You should use the one that fits
the shape of your app.

Use **Vercel AI SDK** if you primarily need a polished provider abstraction,
streaming helpers, and first-class integration with Vercel/React app patterns.
Roy is lower-level around UI and deployment, but more opinionated about
compaction, memory extraction, and session lifecycle.

Use **Mastra** if you want a broader TypeScript agent framework with more
batteries included around workflows, memory, evals, and deployment. Roy is a
smaller runtime that focuses on chat sessions, tool loops, explicit approval
gates, handoff context, and context management.

Use **LangChain.js or LangGraph** if you want the largest ecosystem of chains,
retrievers, integrations, and graph orchestration. Roy has a narrower API and a
smaller surface area, with fewer abstractions between your app and the model
turn.

Use **assistant-ui** if your main need is a mature shadcn-based chat UI. Roy's
React package is intentionally thin; the core runtime is the main package.

Roy is the right fit when the hard part of your app is not "how do I stream a
message?" but "how do I keep an agent useful after the conversation, tool
results, user preferences, and cost history all start accumulating?"

## Upgrading To 0.2.0

Roy `0.2.0` is the first release after the public repo/package cleanup. The
important changes are mostly around API clarity:

- Use `@chatroy/*` everywhere. The repo metadata, examples, workspace
  dependencies, and CI now match the published npm scope.
- Plan mode is explicit. Use `roy.requestPlan(sessionId)` or
  `send({ sessionId, input, requestPlan: true })`, then listen for
  `approval-requested`. Roy does not infer approval gates from assistant prose.
- Treat run events as the host-app lifecycle contract. Prefer
  `agent-start`, `tool-call`, `tool-result`, `handoff`, `approval-requested`,
  `cost-updated`, `done`, and `error` over parsing streamed text.
- Keep durable workflow orchestration in your app. Roy validates handoffs and
  packages context; your host owns retries, pause/resume/cancel, event logs,
  approvals, and UI supervision.
- `@chatroy/pgvector` now includes `PgVectorStore` for embedding storage and
  similarity search. Session and memory persistence remain JSONB-backed.

See [CHANGELOG.md](./CHANGELOG.md) for the full release notes.

## Monorepo Development

This repository uses pnpm workspaces and Turborepo.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

Useful package-scoped commands:

```bash
pnpm --filter @chatroy/core test
pnpm --filter @chatroy/core dev
pnpm --filter @chatroy/react build
pnpm --filter @chatroy/pgvector typecheck
```

## Published Artifacts

Roy intentionally publishes `dist`, TypeScript source, declaration maps, and
JavaScript source maps. This keeps early releases transparent and makes consumer
debugging much easier.

See [PUBLISHING.md](./PUBLISHING.md) for the release checklist.

## Security

See [SECURITY.md](./SECURITY.md) for supported versions, vulnerability
reporting, and package security practices.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, pull request guidance,
and the project boundaries Roy is trying to preserve.

## License

MIT
