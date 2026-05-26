# Publishing

Roy publishes three public npm packages:

- `@chatroy/core`
- `@chatroy/react`
- `@chatroy/pgvector`

Current release target: `0.2.0`.

## Release Checklist

1. Confirm the working tree contains only intended release changes.
2. Confirm all publishable package manifests use the same version:

   ```bash
   node -e "for (const p of ['packages/core/package.json','packages/react/package.json','packages/pgvector/package.json']) console.log(p, require('./' + p).version)"
   ```

3. Confirm npm still has the previous version:

   ```bash
   npm view @chatroy/core version
   npm view @chatroy/react version
   npm view @chatroy/pgvector version
   ```

4. Run the release preflight:

   ```bash
   pnpm test
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm audit --prod
   pnpm pack -r --dry-run
   git diff --check
   ```

5. Commit the release prep.
6. Tag the release:

   ```bash
   git tag v0.2.0
   ```

7. Publish with npm 2FA:

   ```bash
   pnpm publish -r --access public --otp <code>
   ```

8. Push the commit and tag:

   ```bash
   git push origin main --follow-tags
   ```

## Recommended Future Setup

Use npm Trusted Publishing from CI with provenance instead of local manual
publishing. This avoids long-lived publish tokens and gives consumers a stronger
supply-chain signal.

## Source Maps

Roy intentionally publishes JavaScript source maps and declaration maps. Do not
remove `*.map` files from `dist` unless the release policy changes.
