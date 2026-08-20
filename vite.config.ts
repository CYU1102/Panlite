import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { copyFileSync } from 'fs'
import type { Plugin } from 'vite'

/** Remove crossorigin attributes from HTML tags — breaks file:// in Electron */
function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '')
    },
  }
}

function copyWebviewPreload(): Plugin {
  return {
    name: 'copy-webview-preload',
    closeBundle() {
      copyFileSync(
        resolve(__dirname, 'src/renderer/preload-extract.js'),
        resolve(__dirname, 'dist/renderer/preload-extract.js'),
      )
    },
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'webview',
        },
      },
    }),
    removeCrossorigin(),
    copyWebviewPreload(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('element-plus')) return 'element-plus'
          if (id.includes('lucide-vue-next') || id.includes('@element-plus/icons-vue')) return 'icons'
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('pinia')) return 'vue-core'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
  },
})
