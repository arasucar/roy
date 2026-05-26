# @chatroy/core

Core package for Roy, a TypeScript LLM chat runtime with multi-provider
streaming, tool calls, rolling context compaction, memory extraction, explicit
plan approval, handoff context primitives, host-app run events, and cost
tracking.

Current release: `0.2.0`.

## Install

```bash
pnpm add @chatroy/core
```

Install only the provider SDKs you use:

```bash
pnpm add openai
pnpm add @anthropic-ai/sdk
pnpm add @google/generative-ai
```

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
      systemPrompt: 'You are concise and helpful.',
    },
  ],
})

for await (const chunk of roy.send({ input: 'Say hello' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta)
}
```

## Included

- OpenAI, Anthropic, Gemini, OpenRouter, and Ollama provider adapters.
- Tool definition and tool-loop orchestration.
- Rolling compaction with tool truncation, summaries, rollovers, and events.
- Structured memory extraction through user-defined Zod schemas.
- Handoff validation/context primitives; host apps own workflow loops.
- Explicit plan approval primitives. Roy does not infer gates from assistant
  prose.
- Stable run events for agent start/end, tool calls/results, handoffs, approval
  requests, cost updates, completion, and errors.
- In-memory and file session stores.
- Cost estimation helpers.

## Compaction

Roy uses the current prompt budget to trigger compaction. The compactor can
include pending user input in the preflight estimate without compacting that
fresh message.

Compaction strategies return source messages through `compactedMessages`, so
host apps can extract durable memory before detail is removed from active
context.

## Plan Mode

Plan mode is explicit. In plan mode, tools are disabled until the host requests a
plan and the approval callback approves it.

```ts
roy.on('approval-requested', ({ plan }) => {
  showApprovalUi(plan)
})

await roy.requestPlan(sessionId)
```

Roy does not watch for `[PLAN_READY]` or any other text heuristic.

## Run Events

Roy emits typed events for host supervision and UI state:

- `agent-start` / `agent-end`
- `tool-call` / `tool-result`
- `handoff`
- `plan-ready` / `approval-requested` / `plan-approved` / `plan-rejected`
- `cost-updated`
- `done`
- `error`

Prefer these events over parsing assistant text when building logs, approval
surfaces, or workflow state machines.

## Handoffs

Roy exposes handoff validation and optional compact context events. It does not
run a full durable multi-agent workflow; keep retries, pause/resume/cancel,
durable run state, event logs, and UI supervision in your host application.

## Published Artifacts

This package intentionally publishes `dist`, `src`, declaration maps, and
JavaScript source maps.

## License

MIT
