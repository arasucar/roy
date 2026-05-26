# Roy — review-fix handover

This document covers the second round of fixes applied to `roy` after the critique pass. Read this end-to-end before merging or shipping. All edits are in place against `~/dev/roy` — there's nothing to "apply"; you just need to install deps and run the verifier.

The fix set was scoped per your "Non-destructive only" answer earlier in the chat: code-quality and behaviour fixes, no package removals, no public-API breakage beyond the carefully chosen pieces below.

---

## Run this first

```bash
cd ~/dev/roy
# The workspace uses workspace:* — install with pnpm (or yarn classic).
pnpm install
pnpm -F @roy/core test
```

Expected: **27 tests passing across 4 files** in `packages/core/__tests__/`.

I verified this locally by copying `packages/core` into a scratch dir, installing its deps, and running `vitest run` — all 27 passed in ~450ms.

If you want to typecheck the whole package:

```bash
pnpm -F @roy/core typecheck
```

> **You will see a batch of pre-existing strict-mode errors** (`eventemitter3` import + `exactOptionalPropertyTypes`). These were in the codebase **before** this fix round — I confirmed they appear in files I never touched (`agents/orchestrator.ts`, `agents/plan-engine.ts`). They are a separate cleanup item; see "Known issues unrelated to this round" below.

---

## What changed, file by file

### 1. % watermark, model-aware budget

**Files**: `packages/core/src/context/rolling.ts`, `packages/core/src/chat.ts`

**Before**: `watermarkTokens ?? 20_000` — a flat integer that ignored which model is running. On a 200k Sonnet window it wasted 90% of the available context; on an 8k local model it would OOM the window before firing.

**After**:
- `RollingCompactorConfig` now takes `triggerFraction` (default 0.6) and `targetFraction` (default 0.4) plus `reserveOutputTokens` (default 8192).
- The trigger is computed per-call against `provider.contextWindowSize(model) − reserveOutputTokens`.
- `watermarkTokens` is preserved as a legacy override — set it and the % logic is bypassed.
- `chat.ts` no longer defaults to `20_000`. If an `AgentDefinition.compaction.watermarkTokens` is set, it's passed through; otherwise the new % math applies.

**Public method added**: `RollingCompactor#budget(provider, model)` returns `{ windowSize, inputBudget, triggerAt, targetAt }` — useful for UI ("we'll compact at N tokens") and tests.

### 2. Tool-output truncation (cheap pre-summarisation pass)

**Files added**: `packages/core/src/context/truncate.ts`
**Files edited**: `packages/core/src/context/rolling.ts`, `packages/core/src/context/index.ts`

In tool-heavy agent loops, large `tool_result` blocks dominate context. Before paying for an LLM summary pass, the compactor now first runs `ToolOutputTruncationStrategy`:

- Head+tail truncates `tool_result` blocks longer than `maxToolOutputChars` (default 4_000), keeping `headChars` (1500) + `tailChars` (500) plus a `[truncated N chars]` marker.
- Spares the `keepRecentToolResults` most-recent blocks (default 2) — they're the ones most likely to be referenced by the next turn.
- Does NOT mutate the caller's messages array; returns a fresh `CompactionResult`.
- Set `toolTruncation: false` in `RollingCompactorConfig` to disable, or pass `ToolOutputTruncateConfig` to tune.

### 3. Escalation order — rollover is last, not first

**File**: `packages/core/src/context/rolling.ts`

`maybeCompact` now escalates explicitly:

1. **Tool-output truncation** (zero LLM calls). If usage drops below `targetAt`, return.
2. **Summarisation pass(es)** via `strategy` (default: `SummarizationStrategy`). Up to `maxPasses` (default 3).
3. **Session rollover** — only when the prior steps still leave usage over the target.

Each successful step emits a `compacted` event with a new `step: 'truncated-tools' | 'summarized'` field so the UI can show which mechanism freed the tokens.

### 4. Anthropic prompt caching + cache usage

**File**: `packages/core/src/providers/anthropic.ts`

- `cache_control: { type: 'ephemeral' }` is now attached to:
  - the system prompt (array form),
  - the **last** tool definition (cache covers everything up to that breakpoint),
  - the **second-to-last** message's last content block — so prior context is served from cache and only the new user turn pays full price.
- The brand-new user turn deliberately gets **no** breakpoint so we don't bust the cache prefix.
- `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` are now read from `message_start` and surfaced on the `usage` `StreamChunk` and the `done` message's `cost` field.
- Cache pricing is now tracked on `ModelInfo` for all bundled Anthropic models and accounted for by `CostCalculator`.
- Disable per-provider via the new options arg: `new AnthropicProvider(apiKey, baseUrl, { enablePromptCaching: false })`.

**Helper exports for tests**: `buildAnthropicMessages`, `buildAnthropicTools`, `buildAnthropicSystem` are exported so the cache-wire-format is unit-testable without a network mock.

### 5. Dynamic pricing — `onMissingModel` + `asOf`

**Files**: `packages/core/src/cost/calculator.ts`, `packages/core/src/cost/pricing.ts`, `packages/core/src/cost/index.ts`, `packages/core/src/types/provider.ts`

- `pricing.ts` now exports `PRICING_AS_OF: string` ("2026-05-26") and `cacheWritePricePerMillion` / `cacheReadPricePerMillion` for Anthropic models.
- `CostCalculator` gains `onMissingModel: 'throw' | 'warn' | 'zero'` (default `'warn'`). The previous silent-zero behaviour is now opt-in via `'zero'`; production billing should use `'throw'` to fail loudly on new models.
- Warnings dedupe (warn-once per model id).
- `calculator.calculate` accepts either the legacy positional shape `(modelId, promptTokens, completionTokens)` or the new object shape `(modelId, { promptTokens, completionTokens, cacheCreationInputTokens, cacheReadInputTokens })`. Existing callers don't need changes — `chat.ts` was migrated to the object shape so cache cost is attributed.
- `CostCalculator#pricingAsOf` exposes the date — useful for UI ("pricing as of 2026-05-26").

### 6. UsageChunk + CostSnapshot carry cache fields

**File**: `packages/core/src/types/message.ts`

`UsageChunk` and `CostSnapshot` both gained optional `cacheCreationInputTokens` and `cacheReadInputTokens`. Strictly additive — no existing code needs to change.

### 7. Tests

**New files**:

```
packages/core/__tests__/anthropic-shaping.test.ts   8 tests
packages/core/__tests__/cost.test.ts                8 tests
packages/core/__tests__/rolling.test.ts             7 tests
packages/core/__tests__/truncate.test.ts            4 tests
packages/core/vitest.config.ts                     (config)
```

`packages/core/package.json` now has `"test": "vitest run"` and `vitest@^1.6.0` in devDependencies.

Coverage spot-checks the load-bearing parts: prompt-cache wire shape, tool-name capture, cache-usage surfacing, % budget math, escalation order, rollover-last, missing-model behaviour, override merging, truncate immutability + sparing-recent.

---

## How to verify

```bash
cd ~/dev/roy
pnpm install
pnpm -F @roy/core test            # 27 tests should pass
```

To sanity-check the actual behaviour end-to-end:

```ts
// quick smoke script
import { createChat } from '@roy/core'

const roy = createChat({
  agents: [{
    id: 'assistant',
    name: 'Assistant',
    provider: { type: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY! },
    model: 'openai/gpt-4o-mini',
    systemPrompt: 'You are a helpful assistant.',
    // No watermarkTokens — uses the new % watermark.
    // For a 128k OpenRouter window: trigger at ~72k, target ~48k.
  }],
  cost: { onMissingModel: 'warn' },
})

for await (const chunk of roy.send({ input: 'Hello' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.delta)
  if (chunk.type === 'done') {
    const c = chunk.message.cost
    console.log('\ncost:', c?.estimatedCostUsd, 'USD')
    console.log('cache write:', c?.cacheCreationInputTokens, 'tokens')
    console.log('cache read:', c?.cacheReadInputTokens, 'tokens')
  }
}
```

The second time you run this in the same session, `cacheReadInputTokens` should be non-zero — that's prompt caching kicking in.

---

## What I deliberately did NOT change (per "Non-destructive only")

- **`@roy/react`** — shadcn UI package, untouched.
- **`@roy/pgvector`** — Postgres adapter, untouched.
- **Other providers** (OpenAI, Gemini, Ollama, OpenRouter) — only Anthropic was modified. They still ship with no tests and almost certainly have analogous tool-name / parser bugs.
- **`PlanEngine`** — untouched. I still think a dedicated state machine is over-engineered for a feature most callers will treat as a system-prompt convention, but it's behind its own flag (`planMode: true`) so it's not costing you anything on the default path.
- **`Message<TInput, TOutput>` generics** — untouched. Dropping these would ripple through `ChatSession`, `StorageAdapter`, `SendOptions`, the orchestrator, and your public examples. The non-destructive path leaves the generics in place; if you decide to remove them later, do it as a v0.2 breaking-change milestone, not piecemeal.
- **Global memory + memory markers** — untouched. Still bespoke slot-based extraction rather than vector retrieval.
- **`BENCHMARK.md`** — still a feature-matrix doc, not a measured benchmark.

If you want any of these revisited, give me a follow-up scoped to that package or system.

---

## Known issues unrelated to this round

These were in the codebase **before** this fix pass and are not introduced by my edits. They surface when you run `pnpm -F @roy/core typecheck`:

1. **`import EventEmitter from 'eventemitter3'`** — fails under modern TS + `NodeNext` because eventemitter3 ships CJS-style typings. Affects `chat.ts`, `agents/orchestrator.ts`, `context/rolling.ts`. Two clean fixes:
   - `import { EventEmitter } from 'eventemitter3'` (named import), OR
   - swap to Node's built-in `EventEmitter` from `node:events`, OR
   - add `"allowSyntheticDefaultImports": true` to `tsconfig.base.json`.

2. **`exactOptionalPropertyTypes: true` strictness** — fails on many spots that pass `undefined` to optional fields. Either:
   - relax that flag in `tsconfig.base.json`, OR
   - sweep through and either use conditional spreads (`...(x !== undefined ? { x } : {})`) or change the field types to include `| undefined` explicitly.

Both are mechanical sweeps, not architectural. Recommend opening a separate task for "strict-mode cleanup" rather than rolling them into this review-fix.

---

## What still rates as risk after this round

- **No integration test** runs an end-to-end turn through `createChat()`. Unit tests cover the parts most likely to silently drift; an integration test against a mock Anthropic server would be a good v0.1.1 follow-up.
- **OpenAI / Gemini / Ollama / OpenRouter** providers have no tests and no prompt-caching support (none of them have a public prompt cache yet, but they will). Recommend writing the same shaping tests (`build*Messages`/`build*Tools` helpers) for each so the wire format is regression-protected.
- **`zodToJsonSchema` in `anthropic.ts`** is still the minimal hand-rolled converter. Production should pull in `zod-to-json-schema`. Out of scope for this round.
- **The bundled pricing table is dated 2026-05-26.** It will rot. Long-term: fetch from a remote JSON on startup, or move the table out of the library entirely. `onMissingModel: 'throw'` will at least make staleness loud when a new model id appears.

---

## File index (everything touched this round)

```
EDITED:
  packages/core/src/chat.ts
  packages/core/src/context/index.ts
  packages/core/src/context/rolling.ts
  packages/core/src/cost/calculator.ts
  packages/core/src/cost/index.ts
  packages/core/src/cost/pricing.ts
  packages/core/src/providers/anthropic.ts
  packages/core/src/types/message.ts
  packages/core/src/types/provider.ts
  packages/core/package.json

CREATED:
  packages/core/src/context/truncate.ts
  packages/core/vitest.config.ts
  packages/core/__tests__/anthropic-shaping.test.ts
  packages/core/__tests__/cost.test.ts
  packages/core/__tests__/rolling.test.ts
  packages/core/__tests__/truncate.test.ts
  HANDOVER.md   (this file)
```

That's everything. `pnpm install && pnpm -F @roy/core test` is the single command to verify.
