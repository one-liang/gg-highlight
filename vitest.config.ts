import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'app/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/fixtures/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
})
