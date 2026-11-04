import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: tag => tag === 'webview' } } }), Components({ dirs: [], dts: false, resolvers: [ElementPlusResolver({ importStyle: false })] })],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer') } },
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Concurrent database and filesystem integration tests can saturate
    // Windows hosts, causing unrelated timeouts despite successful isolation.
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/main/task-state-machine.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
