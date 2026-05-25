# Roy — Benchmark: TypeScript LLM Chat Libraries

> **Date:** May 2026  
> **Scope:** TypeScript/Node.js LLM chat libraries evaluated on 8 dimensions that matter for production chat applications.  
> **Note:** All code examples show the minimal idiomatic usage for each library. Complexity ratings are relative (1 = simplest, 5 = most complex to set up).

---

## Libraries Evaluated

| Library | Version (approx.) | Maintained by | npm weekly DLs |
|---|---|---|---|
| **Roy** | 0.1.0 | You | — |
| **Vercel AI SDK** | 3.x | Vercel | ~2.5M |
| **LangChain.js** | 0.2.x | LangChain Inc. | ~600K |
| **LlamaIndex.ts** | 0.5.x | LlamaIndex | ~150K |
| **Mastra** | 0.1.x | Mastra | ~50K |
| **OpenAI Agents SDK** | 0.0.x | OpenAI | ~80K |

---

## Dimension 1: Multi-Provider Support

### Roy
```ts
// Switch provider per agent — or per message
const roy = createChat({
  agents: [
    {
      id: 'fast',
      provider: { type: 'openai', apiKey: process.env.OPENAI_KEY! },
      model: 'gpt-4o-mini',
      systemPrompt: 'You are a fast responder.',
    },
    {
      id: 'deep',
      provider: { type: 'anthropic', apiKey: process.env.ANTHROPIC_KEY! },
      model: 'claude-opus-4-6',
      systemPrompt: 'You are a deep thinker.',
    },
    {
      id: 'local',
      provider: { type: 'ollama', baseUrl: 'http://localhost:11434' },
      model: 'llama3',
      systemPrompt: 'You are a local assistant.',
    },
  ],
})

// Route to different providers mid-conversation
for await (const chunk of roy.send({ input: 'Quick question', agentId: 'fast' })) { ... }
for await (const chunk of roy.send({ input: 'Deep analysis', agentId: 'deep' })) { ... }
```

### Vercel AI SDK
```ts
import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'

// Provider is per-call — no unified session routing
const { text: a } = await generateText({ model: anthropic('claude-opus-4-6'), prompt: '...' })
const { text: b } = await generateText({ model: openai('gpt-4o'), prompt: '...' })
// ✗ No multi-agent routing — each call is independent
```

### LangChain.js
```ts
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

// Separate instances, no unified routing layer
const claudeModel = new ChatAnthropic({ model: 'claude-opus-4-6' })
const gptModel = new ChatOpenAI({ model: 'gpt-4o' })
// ✗ Multi-provider requires manual orchestration or LCEL chains
```

### LlamaIndex.ts
```ts
import { Anthropic, OpenAI } from 'llamaindex'

// Provider per LLM instance — no unified session layer
const llm = new Anthropic({ model: 'claude-opus-4-6' })
// ✗ No built-in multi-provider routing
```

### Mastra
```ts
import { Agent } from '@mastra/core'
import { anthropic } from '@ai-sdk/anthropic'

// Mastra uses Vercel AI SDK under the hood — single provider per agent
const agent = new Agent({ name: 'assistant', model: anthropic('claude-opus-4-6') })
// ✓ Per-agent providers, similar to Roy
```

### OpenAI Agents SDK
```ts
import { Agent } from '@openai/agents'

// OpenAI-only — no multi-provider support
const agent = new Agent({ name: 'assistant', model: 'gpt-4o' })
// ✗ Locked to OpenAI models
```

**Verdict:**

| Library | Providers | Per-agent routing | Easy to switch |
|---|---|---|---|
| **Roy** | Anthropic, OpenAI, Gemini, Ollama, OpenRouter | ✅ | ✅ |
| Vercel AI SDK | ~15 providers | ✅ (per-call) | ✅ |
| LangChain.js | ~20 providers | Manual | ⚠️ |
| LlamaIndex.ts | ~10 providers | Manual | ⚠️ |
| Mastra | Via AI SDK | ✅ (per-agent) | ✅ |
| OpenAI Agents SDK | OpenAI only | ❌ | ❌ |

---

## Dimension 2: Context Management & Auto-Compaction

This is where most libraries fail. Context management is either manual or absent.

### Roy
```ts
const roy = createChat({
  agents: [{
    id: 'assistant',
    provider: { type: 'anthropic', apiKey: '...' },
    model: 'claude-sonnet-4-6',
    systemPrompt: '...',
    compaction: {
      watermarkTokens: 20_000,      // fires every 20k cumulative tokens
      summaryPrompt: `
        Summarize this conversation preserving: decisions, facts, preferences.
        Conversation: {{messages}}
      `,
    },
  }],
})

// Compaction fires automatically before each send — zero user effort
roy.on('compacted', ({ tokensFreed, passNumber }) => {
  console.log(`Pass ${passNumber}: freed ${tokensFreed} tokens`)
})

// Session rollover when context is exhausted
roy.on('session-rollover', ({ oldSessionId, newSessionId, summaryText }) => {
  console.log('New session started. Summary carried forward:', summaryText)
  // UI: show SessionRolloverAlert component
})
```

### Vercel AI SDK
```ts
import { generateText } from 'ai'

// No built-in compaction — you manage context manually
const messages = [...history]
if (messages.length > 20) {
  messages.splice(0, messages.length - 20) // crude sliding window
}
const result = await generateText({ model, messages })
// ✗ No rolling compaction, no summarization, no rollover events
```

### LangChain.js
```ts
import { ConversationSummaryMemory } from 'langchain/memory'
import { ChatOpenAI } from '@langchain/openai'

// LangChain has summarization memory — closest to Roy's approach
const memory = new ConversationSummaryMemory({
  llm: new ChatOpenAI({ model: 'gpt-3.5-turbo' }),
  maxTokenLimit: 4000,
})
// ⚠️ Triggers on token limit, not a rolling watermark
// ⚠️ No session rollover concept — just silently trims
// ⚠️ Not configurable without subclassing
```

### LlamaIndex.ts
```ts
import { SimpleChatEngine, CompactAndRefine } from 'llamaindex'

// LlamaIndex focuses on RAG — chat compaction is not a first-class feature
const engine = new SimpleChatEngine({ llm })
// ✗ No rolling compaction, no summarization strategy
```

### Mastra
```ts
// Mastra has a "memory" system but no rolling compaction
import { MastraMemory } from '@mastra/memory'

const memory = new MastraMemory({ provider: 'upstash' })
// ⚠️ Memory stores conversation history, no compaction watermark
// ⚠️ Requires external service (Upstash)
```

### OpenAI Agents SDK
```ts
// No compaction — uses OpenAI's extended context window implicitly
const agent = new Agent({ name: 'assistant', model: 'o3' })
// ✗ Relies on large context windows rather than compaction
// ✗ Will fail or error when context limit is hit
```

**Verdict:**

| Library | Auto-compaction | Configurable strategy | Session rollover | Custom summary prompt |
|---|---|---|---|---|
| **Roy** | ✅ Rolling watermark | ✅ Pluggable | ✅ With events | ✅ |
| Vercel AI SDK | ❌ | ❌ | ❌ | ❌ |
| LangChain.js | ⚠️ Token limit only | ⚠️ Limited | ❌ | ❌ |
| LlamaIndex.ts | ❌ | ❌ | ❌ | ❌ |
| Mastra | ❌ | ❌ | ❌ | ❌ |
| OpenAI Agents SDK | ❌ | ❌ | ❌ | ❌ |

---

## Dimension 3: Type Safety & Generic I/O

### Roy
```ts
import { createChat, defineTool } from '@roy/core'
import { z } from 'zod'

// Fully generic Message<TInput, TOutput>
interface SearchInput { query: string; filters?: string[] }
interface SearchOutput { results: Result[]; totalCount: number }

const searchTool = defineTool({
  name: 'search',
  description: 'Search the knowledge base',
  parameters: z.object({
    query: z.string(),
    maxResults: z.number().default(10),
  }),
  execute: async ({ query, maxResults }): Promise<SearchOutput> => {
    return knowledgeBase.search(query, maxResults) // fully typed
  },
})

// Messages carry typed input/output
const session = await roy.newSession()
for await (const chunk of roy.send<SearchInput>({
  input: { query: 'TypeScript best practices', filters: ['2025'] },
  sessionId: session.id,
})) {
  if (chunk.type === 'done') {
    const msg = chunk.message // Message<SearchInput, string>
    console.log(msg.input?.query) // typed ✓
  }
}
```

### Vercel AI SDK
```ts
import { generateObject } from 'ai'
import { z } from 'zod'

// ✓ generateObject gives typed output
const { object } = await generateObject({
  model,
  schema: z.object({ results: z.array(z.string()) }),
  prompt: '...',
})
// ✓ Output is typed
// ✗ Input is always string — no generic Message<TIn, TOut>
// ✗ No typed session messages
```

### LangChain.js
```ts
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { z } from 'zod'

// ⚠️ Types are present but complex — lots of type gymnastics
const chain = ChatPromptTemplate.fromMessages([...])
  .pipe(model)
  .pipe(new JsonOutputParser())
// ✗ Message types are generic BaseMessage — not user-defined
// ✗ Tool inputs/outputs use any extensively internally
```

**Verdict:**

| Library | Generic Message<TIn,TOut> | Zod tool params | Typed tool output | Strict tsconfig |
|---|---|---|---|---|
| **Roy** | ✅ | ✅ | ✅ | ✅ |
| Vercel AI SDK | ❌ | ✅ | ✅ | ✅ |
| LangChain.js | ❌ | ⚠️ | ⚠️ | ❌ |
| LlamaIndex.ts | ❌ | ⚠️ | ⚠️ | ❌ |
| Mastra | ⚠️ | ✅ | ✅ | ✅ |
| OpenAI Agents SDK | ❌ | ✅ | ✅ | ✅ |

---

## Dimension 4: Multi-Agent System

### Roy
```ts
const roy = createChat({
  agents: [
    {
      id: 'router',
      provider: { type: 'anthropic', apiKey: '...' },
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'Classify the intent and route to the correct specialist.',
      cycle: {
        maxHops: 5,
        loopStrategy: 'escalate',
        allowedHandoffTargets: ['specialist-a', 'specialist-b'],
        routingFn: async ({ lastMessageContent }) => {
          if (lastMessageContent.includes('billing')) return 'specialist-a'
          if (lastMessageContent.includes('technical')) return 'specialist-b'
          return undefined // let orchestrator decide
        },
      },
    },
    {
      id: 'specialist-a',
      provider: { type: 'openai', apiKey: '...' },
      model: 'gpt-4o',
      systemPrompt: 'You handle billing inquiries.',
    },
    {
      id: 'specialist-b',
      provider: { type: 'anthropic', apiKey: '...' },
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You handle technical support.',
    },
  ],
})

roy.on('agent-handoff', ({ from, to, hopNumber }) => {
  console.log(`Hop ${hopNumber}: ${from} → ${to}`)
})
```

### Vercel AI SDK
```ts
// No built-in multi-agent system
// You'd need to manually route between generateText calls
// ✗ No agent registry, no handoff protocol, no cycle detection
```

### LangChain.js
```ts
import { AgentExecutor } from 'langchain/agents'

// LangChain has agents but no multi-agent orchestration
const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt })
const executor = new AgentExecutor({ agent, tools })
// ✗ Single-agent per executor — no built-in handoff
// ✗ No cycle detection
// Use LangGraph (separate package) for multi-agent
```

### LangGraph (LangChain extension)
```ts
import { StateGraph } from '@langchain/langgraph'

// LangGraph provides graph-based multi-agent — closest to Roy's agent system
const workflow = new StateGraph({ channels: ... })
  .addNode('agent_a', agentA)
  .addNode('agent_b', agentB)
  .addEdge('agent_a', 'agent_b')
// ✓ Graph-based, powerful
// ✗ Very complex setup — 100+ lines for simple routing
// ✗ No built-in cycle detection or hop limits
// ✗ Separate package from LangChain core
```

### Mastra
```ts
import { Agent, MastraEngine } from '@mastra/core'

// Mastra has an agent system with workflows
const agentA = new Agent({ name: 'router', model: claude('claude-sonnet-4-6') })
const agentB = new Agent({ name: 'worker', model: openai('gpt-4o') })
// ⚠️ Handoff requires workflow definition — not dynamic routing
// ⚠️ No built-in cycle detection
```

### OpenAI Agents SDK
```ts
import { Agent, handoff } from '@openai/agents'

// OpenAI SDK has first-class handoffs
const triage = new Agent({
  name: 'triage',
  handoffs: [billingAgent, techAgent],
})
// ✓ Handoff concept built-in
// ✗ OpenAI-only
// ✗ Limited cycle configuration
```

**Verdict:**

| Library | Agent registry | Dynamic routing | Cycle detection | Configurable hops | Loop strategies |
|---|---|---|---|---|---|
| **Roy** | ✅ | ✅ routingFn | ✅ | ✅ | break/retry/escalate |
| Vercel AI SDK | ❌ | ❌ | ❌ | ❌ | ❌ |
| LangChain.js | ❌ | ❌ | ❌ | ❌ | ❌ |
| LangGraph | ✅ | ✅ | ⚠️ Manual | ⚠️ Manual | ⚠️ Manual |
| Mastra | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| OpenAI Agents SDK | ✅ | ⚠️ | ❌ | ❌ | ❌ |

---

## Dimension 5: Session Persistence

### Roy
```ts
// FileStore — zero external dependencies
import { createChat, FileStore } from '@roy/core'

const roy = createChat({
  agents: [myAgent],
  store: new FileStore('./sessions'),
})

const session = await roy.newSession('my-agent', 'Project discussion')

// Resume later
for await (const chunk of roy.send({
  input: 'What did we decide last time?',
  sessionId: session.id,     // carries full context
})) { ... }

// Branch at any point
const branch = await roy.branchSession(session.id, {
  fromMessageId: 'msg-42',
  label: 'Alternative approach',
})

// pgvector for production
import { PgSessionStore } from '@roy/pgvector'
const store = new PgSessionStore({ connectionString: process.env.DATABASE_URL! })
```

### Vercel AI SDK
```ts
// No session management — you manage state yourself
let messages: Message[] = []
const { text } = await generateText({ model, messages })
messages = [...messages, { role: 'assistant', content: text }]
// You're responsible for: persistence, loading, branching
// ✗ No FileStore, no DB adapter, no branching
```

### LangChain.js
```ts
import { MongoDBChatMessageHistory } from '@langchain/mongodb'
import { ConversationChain } from 'langchain/chains'

// LangChain has chat history — requires external store
const history = new MongoDBChatMessageHistory({ sessionId, collection })
const chain = new ConversationChain({ memory: new BufferMemory({ chatHistory: history }) })
// ✓ Pluggable history backends
// ✗ No branching
// ✗ No session metadata or status
```

**Verdict:**

| Library | Built-in stores | Pluggable adapter | Session branching | Rollover linking |
|---|---|---|---|---|
| **Roy** | Memory, File | ✅ | ✅ | ✅ |
| Vercel AI SDK | ❌ | ❌ | ❌ | ❌ |
| LangChain.js | ❌ (external) | ✅ | ❌ | ❌ |
| LlamaIndex.ts | ❌ | ⚠️ | ❌ | ❌ |
| Mastra | Upstash only | ⚠️ | ❌ | ❌ |
| OpenAI Agents SDK | ❌ | ❌ | ❌ | ❌ |

---

## Dimension 6: Plan Mode

### Roy
```ts
const planningAgent: AgentDefinition = {
  id: 'planner',
  provider: { type: 'anthropic', apiKey: '...' },
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a careful planner. Gather requirements before acting.',
  planMode: true,
  // Programmatic approval callback — works in any context (CLI, API, UI)
  onPlanApproval: async (plan) => {
    console.log('Plan:', plan.title)
    plan.steps.forEach((s) => console.log(`  ${s.order}. ${s.title}`))

    const answer = await promptUser('Approve? (y/n): ')
    return { approved: answer === 'y', rejectionReason: answer !== 'y' ? 'User rejected' : undefined }
  },
}

roy.on('plan-ready', ({ plan }) => console.log('Plan ready:', plan.title))
roy.on('plan-approved', ({ plan }) => console.log('Executing:', plan.steps.length, 'steps'))
roy.on('plan-rejected', ({ plan }) => console.log('Rejected:', plan.rejectionReason))
```

### All other libraries
```
✗ None of the evaluated libraries have a built-in plan mode.
  LangGraph has a "human-in-the-loop" concept (interrupt/resume)
  but it requires graph-level setup and has no structured PlanDocument output.
```

**Verdict:**

| Library | Plan mode | Structured PlanDocument | Programmatic approval | UI component |
|---|---|---|---|---|
| **Roy** | ✅ | ✅ | ✅ | ✅ (PlanApproval) |
| All others | ❌ | ❌ | ❌ | ❌ |

---

## Dimension 7: Global Memory (Cross-Session)

### Roy
```ts
import { z } from 'zod'
import { createChat } from '@roy/core'
import { PgMemoryStore } from '@roy/pgvector'

const roy = createChat({
  agents: [myAgent],
  memory: {
    schema: {
      slots: [
        {
          name: 'user_preferences',
          description: 'Preferences and constraints stated by the user',
          schema: z.object({
            preferredLanguage: z.string().optional(),
            outputFormat: z.enum(['markdown', 'json', 'plain']).optional(),
          }),
          mergeStrategy: 'merge',
        },
        {
          name: 'key_decisions',
          description: 'Important decisions made during conversations',
          schema: z.array(z.object({ decision: z.string(), rationale: z.string() })),
          mergeStrategy: 'append',
        },
      ],
    },
    store: new PgMemoryStore({ connectionString: process.env.DATABASE_URL! }),
    injectIntoSystemPrompt: true, // auto-injects into every agent session
  },
})

// Mark messages as important for memory extraction
for await (const chunk of roy.send({
  input: 'I always want responses in markdown format',
  memoryMarker: {
    slots: ['user_preferences'],
    weight: 0.9,
    reason: 'User stated format preference',
  },
})) { ... }

// When compaction runs, marked messages are extracted to memory
// and survive across sessions automatically
```

### Vercel AI SDK
```
✗ No global memory concept.
```

### LangChain.js
```ts
// LangChain has "entity memory" — tracks named entities
import { EntityMemory } from 'langchain/memory'
// ⚠️ Only tracks entities (people, places, things) — not structured schema
// ⚠️ Not cross-session by default
```

### Mastra
```ts
// Mastra has "memory" but it's conversation history, not structured extraction
import { MastraMemory } from '@mastra/memory'
// ⚠️ Semantic search over history — not slot-based extraction
```

**Verdict:**

| Library | Cross-session memory | Schema-defined slots | Auto-extraction on compact | pgvector backed |
|---|---|---|---|---|
| **Roy** | ✅ | ✅ | ✅ | ✅ |
| Vercel AI SDK | ❌ | ❌ | ❌ | ❌ |
| LangChain.js | ⚠️ Entity only | ❌ | ❌ | ❌ |
| LlamaIndex.ts | ⚠️ RAG only | ❌ | ❌ | ✅ |
| Mastra | ⚠️ Semantic only | ❌ | ❌ | ❌ |
| OpenAI Agents SDK | ❌ | ❌ | ❌ | ❌ |

---

## Dimension 8: Cost Estimation

### Roy
```ts
// Built-in pricing table — no setup required
const roy = createChat({ agents: [myAgent] })

// Per-turn cost in every message
for await (const chunk of roy.send({ input: 'Hello' })) {
  if (chunk.type === 'done') {
    const { cost } = chunk.message
    console.log(`${cost.promptTokens} in / ${cost.completionTokens} out`)
    console.log(`Cost: ${CostCalculator.formatCost(cost.estimatedCostUsd)}`)
  }
}

// Session total
const session = await roy.loadSession(sessionId)
console.log(`Session total: $${session.cumulativeCostUsd.toFixed(4)}`)

// Model comparison
const models = roy.listModels('anthropic')
models.forEach((m) => {
  console.log(`${m.name}: $${m.inputPricePerMillion}/M in, $${m.outputPricePerMillion}/M out`)
})

// Custom pricing for enterprise
const roy2 = createChat({
  agents: [myAgent],
  cost: {
    pricingOverrides: { 'claude-sonnet-4-6': { inputPricePerMillion: 2.5 } },
  },
})
```

### Vercel AI SDK
```ts
// Usage is returned — no cost calculation
const { usage } = await generateText({ model, prompt: '...' })
console.log(usage.promptTokens, usage.completionTokens)
// ✗ No pricing table, no cost estimation built-in
// You'd need to build your own calculator
```

### All others
```
All other evaluated libraries return token usage but provide no cost calculation.
You must maintain your own pricing table and calculator.
```

**Verdict:**

| Library | Token usage | Cost per turn | Session total | Pricing table | Custom pricing |
|---|---|---|---|---|---|
| **Roy** | ✅ | ✅ | ✅ | ✅ (built-in) | ✅ |
| Vercel AI SDK | ✅ | ❌ | ❌ | ❌ | ❌ |
| LangChain.js | ✅ | ❌ | ❌ | ❌ | ❌ |
| LlamaIndex.ts | ✅ | ❌ | ❌ | ❌ | ❌ |
| Mastra | ✅ | ❌ | ❌ | ❌ | ❌ |
| OpenAI Agents SDK | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## Overall Scorecard

| Capability | Roy | Vercel AI SDK | LangChain.js | LlamaIndex.ts | Mastra | OpenAI SDK |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Multi-provider | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Auto-compaction | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Type safety | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ |
| Multi-agent | ✅ | ❌ | ⚠️ | ❌ | ⚠️ | ✅ |
| Session persistence | ✅ | ❌ | ⚠️ | ❌ | ⚠️ | ❌ |
| Plan mode | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Global memory | ✅ | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| Cost estimation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| UI components | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| pgvector built-in | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| **Total ✅** | **11/11** | **4/11** | **3/11** | **2/11** | **4/11** | **3/11** |

✅ = First-class support | ⚠️ = Partial/workaround | ❌ = Not supported

---

## When to use each library

**Use Vercel AI SDK** when you're building a Next.js app and want to ship fast. Best-in-class React hooks, RSC streaming, and a huge provider ecosystem. Not suitable for complex agent workflows or long-running sessions.

**Use LangChain.js** when you need a very specific chain or retrieval pattern. Has the most integrations (70+ vector stores, 20+ LLMs). The abstraction cost is high and TypeScript types are inconsistent.

**Use LangGraph** (with LangChain) when you need graph-based agent orchestration with human-in-the-loop. The only other library with comparable multi-agent power — but setup complexity is significantly higher than Roy.

**Use LlamaIndex.ts** when your primary use case is RAG — document ingestion, chunking, and retrieval. Not a general chat library.

**Use Mastra** when you need a full workflow engine (cron jobs, integrations, external tools). It's more like an automation platform than a chat library.

**Use OpenAI Agents SDK** when you're 100% committed to OpenAI and want their opinionated handoff pattern with minimal setup.

**Use Roy** when you need all of the above in one coherent library — especially if long-running sessions, compaction, plan mode, global memory, and multi-provider are requirements.

---

*Roy is a new library — the ecosystem maturity of LangChain and the Vercel AI SDK is significantly higher. Evaluate accordingly for production use.*
