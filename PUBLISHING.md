# Publishing

Roy publishes three public npm packages:

- `@chatroy/core`
- `@chatroy/react`
- `@chatroy/pgvector`

## Release Checklist

1. Confirm the working tree contains only intended release changes.
2. Run:

   ```bash
   pnpm --filter @chatroy/core test
   pnpm typecheck
   pnpm lint
   pnpm audit --prod
   pnpm pack -r --dry-run
   git diff --check
   ```

3. Confirm package names and versions:

   ```bash
   npm view @chatroy/core version
   npm view @chatroy/react version
   npm view @chatroy/pgvector version
   ```

4. Publish from a clean, tagged commit when possible.
5. Publish with npm 2FA:

   ```bash
   pnpm publish -r --access public --otp <code>
   ```

## Recommended Future Setup

Use npm Trusted Publishing from CI with provenance instead of local manual
publishing. This avoids long-lived publish tokens and gives consumers a stronger
supply-chain signal.

## Source Maps

Roy intentionally publishes JavaScript source maps and declaration maps. Do not
remove `*.map` files from `dist` unless the release policy changes.
