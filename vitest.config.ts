import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['runtime/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
  },
})
