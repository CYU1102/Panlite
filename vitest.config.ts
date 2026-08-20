import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
