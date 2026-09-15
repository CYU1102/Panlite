import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve, relative, isAbsolute, extname } from 'path'
import { copyFileSync, readFileSync, cpSync, createReadStream, statSync, mkdirSync } from 'fs'
import type { Plugin } from 'vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

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
  let outDir = ''
  return {
    name: 'copy-webview-preload',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    closeBundle() {
      copyFileSync(
        resolve(__dirname, 'src/renderer/preload-extract.js'),
        resolve(outDir, 'preload-extract.js'),
      )
    },
  }
}

/** PDF.js loads CMaps, standard fonts and decoders relative to the renderer in both modes. */
function pdfAssets(): Plugin {
  const source = resolve(__dirname, 'node_modules/pdfjs-dist')
  const directories = new Set(['cmaps', 'standard_fonts', 'wasm'])
  let outDir = ''
  return {
    name: 'pdf-assets',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/pdf-assets/') || !['GET', 'HEAD'].includes(request.method || '')) return next()
        let name: string
        try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice('/pdf-assets/'.length)) } catch { return next() }
        if (!directories.has(name.split('/')[0])) return next()
        const file = resolve(source, name), within = relative(source, file)
        if (within.startsWith('..') || isAbsolute(within)) return next()
        try { if (!statSync(file).isFile()) return next() } catch { return next() }
        response.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream')
        if (request.method === 'HEAD') return response.end()
        createReadStream(file).on('error', () => response.destroy()).pipe(response)
      })
    },
    closeBundle() {
      mkdirSync(resolve(outDir, 'pdf-assets'), { recursive: true })
      for (const directory of directories) cpSync(resolve(source, directory), resolve(outDir, 'pdf-assets', directory), { recursive: true })
    },
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    Components({ dirs: [], dts: false, resolvers: [ElementPlusResolver({ importStyle: 'css' })] }),
    removeCrossorigin(),
    copyWebviewPreload(),
    pdfAssets(),
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
    cssCodeSplit: true,
    manifest: true,
    modulePreload: false,
    rollupOptions: {
      onwarn(warning, warn) {
        // Upstream VueUse contains two misplaced PURE comments. Rollup safely
        // drops those annotations; keep all other build diagnostics visible.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.replaceAll('\\', '/').includes('/@vueuse/core/dist/index.js')) return
        warn(warning)
      },
      output: {
        manualChunks(id) {
          id = id.replaceAll('\\', '/')
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/pdfjs-dist/')) return 'pdfjs'
          if (id.includes('lucide-vue-next') || id.includes('@element-plus/icons-vue')) return 'icons'
          const component = id.match(/element-plus\/es\/components\/([^/]+)/)?.[1]
          if (component === 'table' || component === 'table-v2') return 'element-table'
          if (component && ['date-picker', 'date-picker-panel', 'time-picker', 'time-select', 'calendar'].includes(component)) return 'element-date'
          if (component && ['tree', 'tree-v2', 'tree-select'].includes(component)) return 'element-tree'
          if (component && ['select', 'select-v2', 'cascader', 'cascader-panel', 'autocomplete', 'mention', 'pagination'].includes(component)) return 'element-select'
          if (id.endsWith('/element-plus/es/index.mjs')) return undefined
          if (id.includes('/element-plus/')) return 'element-base'
          if (id.includes('/vue/') || id.includes('/@vue/') || id.includes('vue-router') || id.includes('pinia')) return 'vue-core'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
  },
})
