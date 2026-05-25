import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // Allow tests to import from `../src/...js` (NodeNext) — vitest resolves
    // these via the TS source files.
    extensions: ['.ts', '.tsx', '.js', '.json'],
  },
})
