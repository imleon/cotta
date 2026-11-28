import { defineConfig } from 'vitest/config'

// Tests run the Hono app in Node against a node:sqlite stand-in for D1 (see src/test-database.ts).
export default defineConfig({ test: { environment: 'node' } })
