import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Electron is not available in the test runner; the few modules that touch
    // it are stubbed per-test-file rather than globally, so the stub stays
    // visible next to the code that needs it.
    restoreMocks: true,
  },
})
