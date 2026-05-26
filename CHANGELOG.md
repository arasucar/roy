# Changelog

## 0.2.0 - 2026-05-26

Release focused on making Roy's public package surface match the published npm
scope and tightening the host-app contracts around plans, handoffs, events, and
retrieval.

### Added

- `PgVectorStore` in `@chatroy/pgvector` for pgvector-backed embedding storage
  and similarity search.
- Stable host-app run events for `agent-start`, `agent-end`, `tool-call`,
  `tool-result`, `handoff`, `approval-requested`, `cost-updated`, `done`, and
  `error`.
- `Roy.requestPlan(sessionId, agentId?)` and `send({ requestPlan: true })` for
  explicit plan drafting in plan-mode agents.
- Root and package-level documentation, package licenses, security notes, and a
  release checklist.

### Changed

- Aligned all workspace metadata, package manifests, examples, React imports,
  and CI references on the public `@chatroy/*` npm scope.
- Clarified that Roy provides handoff validation and context packaging while the
  host app owns durable workflow loops, retries, pause/resume/cancel, event logs,
  and UI supervision.
- Updated plan mode so approval gates are API/state-driven instead of inferred
  from assistant text such as `[PLAN_READY]`.

### Migration Notes

- Replace any remaining `@roy/*` imports with `@chatroy/*`.
- If you relied on text-triggered plan readiness, listen for
  `approval-requested` and call `roy.requestPlan(sessionId)` or send with
  `requestPlan: true`.
- `@chatroy/pgvector` now requires the PostgreSQL `vector` extension when using
  `PgVectorStore`. JSONB session and memory stores continue to work without
  vector search.

## 0.1.0 - 2026-05-26

Initial public release.

- Core chat runtime with streaming provider adapters.
- Tool calls and tool-result feedback loops.
- Rolling context compaction with tool-output truncation, summarization, and
  session rollover.
- Memory extraction with schema-validated slots.
- Agent handoff primitives and explicit plan approval gates.
- React UI components for chat, model selection, compaction, rollover, and plan
  approval.
- PostgreSQL-backed session and memory stores.
- Published TypeScript source and source maps.
