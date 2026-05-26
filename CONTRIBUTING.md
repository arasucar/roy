# Contributing

Thanks for taking a look at Roy. The project is early, so the best
contributions are focused, practical, and tied to real chat-runtime use cases.

## Local Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Roy uses pnpm workspaces and Turborepo. The published packages live under
`packages/*`:

- `@chatroy/core`
- `@chatroy/react`
- `@chatroy/pgvector`

## Before Opening A PR

- Keep package names under the public `@chatroy/*` scope.
- Add or update focused tests for behavior changes.
- Keep provider-specific behavior isolated to the matching provider adapter.
- Keep Roy focused on chat/session/tool/context primitives. Host applications
  should own durable workflow orchestration, retries, pause/resume/cancel,
  approvals, and UI supervision.
- Run the full local check suite before submitting.

## Areas That Are Especially Useful

- More provider-shaping tests.
- Better context-compaction edge cases.
- Examples for long-lived chat sessions and structured memory extraction.
- pgvector retrieval examples using real embedding providers.
- Thin React examples that show host-owned approval and event handling.

## Security Issues

Please do not open public issues for vulnerabilities. See
[SECURITY.md](./SECURITY.md) for reporting guidance.
