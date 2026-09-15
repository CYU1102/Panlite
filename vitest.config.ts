import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [vue(), Components({ dirs: [], dts: false, resolvers: [ElementPlusResolver({ importStyle: false })] })],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer') } },
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/task-state-machine.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
