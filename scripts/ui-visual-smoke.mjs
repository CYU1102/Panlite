import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// All data and Electron sessions are isolated. No account service, desktop input,
// installed application profile, or external network is used by this harness.
const root = resolve(import.meta.dirname, '..')
const quick = process.argv.includes('--quick')
const aiDark = process.argv.includes('--ai-dark')
const output = resolve(root, process.env.PANLITE_UI_OUTPUT || `output/ui-upgrade-20261003/visual-smoke${quick ? '/quick' : ''}`)
const candidates = [process.env.PANLITE_UI_DEPENDENCIES, join(dirname(root), 'PanLite-ui/node_modules'), join(root, 'output/final-release-20260914/workspace/node_modules'), join(root, 'node_modules')].filter(Boolean)
const dependencies = candidates.find(path => existsSync(join(path, '@vue/compiler-sfc/package.json')) && existsSync(join(path, 'vite/package.json')))
const electron = [process.env.PANLITE_UI_ELECTRON, ...candidates.map(path => join(path, 'electron/dist/electron.exe'))].filter(Boolean).find(existsSync)
if (!dependencies || !electron) throw new Error('Existing complete Vite dependencies and Electron runtime are required; this script does not install them.')
if (process.argv.includes('--prepare')) {
  console.log(JSON.stringify({ dependencies, electron, output, hiddenWindows: true, syntheticDataOnly: true }, null, 2))
  process.exit(0)
}
mkdirSync(output, { recursive: true })
const snapshot = join(output, 'workspace')
mkdirSync(snapshot, { recursive: true })
cpSync(join(root, 'src'), join(snapshot, 'src'), { recursive: true })
for (const file of ['vite.config.ts', 'package.json', 'tsconfig.json', 'tsconfig.node.json']) cpSync(join(root, file), join(snapshot, file))
if (!existsSync(join(snapshot, 'node_modules'))) symlinkSync(dependencies, join(snapshot, 'node_modules'), 'junction')
const requireRuntime = createRequire(join(dependencies, '../package.json'))
const { createServer } = await import(pathToFileURL(requireRuntime.resolve('vite')).href)
const account = { id: 'ui-fixture-quark', platform: 'quark', nickname: '设计验收 · 云端资料', status: 'active', createdAt: 1790985600000, updatedAt: 1790985600000 }
const profile = join(output, `profile-${Date.now()}`)
mkdirSync(profile)
const bridgeMethods = [...readFileSync(join(root, 'src/renderer/api/ipc.ts'), 'utf8').matchAll(/^\s{6}(\w+):/gm)].map(match => match[1])
writeFileSync(join(output, 'bridge-methods.json'), JSON.stringify(bridgeMethods))
const server = await createServer({ configFile: join(snapshot, 'vite.config.ts'), cacheDir: join(output, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router', 'lucide-vue-next', 'element-plus', 'element-plus/es'] }, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
  name: 'panlite-isolated-ui-visual-fixture',
  configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__ui-visual')) return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(await vite.transformIndexHtml('/__ui-visual', `<html><head><meta charset="utf-8"></head><body><div id="app"></div><script>window.__UI_VISUAL_ERRORS=[];addEventListener('error',e=>window.__UI_VISUAL_ERRORS.push(e.message));addEventListener('unhandledrejection',e=>window.__UI_VISUAL_ERRORS.push(String(e.reason)));</script><script type="module">import '/main.ts';import router from '/router/index.ts';import {useAppStore} from '/stores/app.ts';const store=useAppStore();store.setAccount(${JSON.stringify(account)});window.__UI_VISUAL_CONTROL={route:async(path)=>{await router.push(path)},theme:async(value)=>{await store.setTheme(value)}};await router.isReady();window.__UI_VISUAL_READY=true;</script></body></html>`))
    })
  },
  }] })
try {
  await server.listen()
  const address = server.httpServer.address()
  const env = { ...process.env, PANLITE_UI_URL: `http://127.0.0.1:${address.port}/__ui-visual`, PANLITE_UI_OUTPUT: output, PANLITE_UI_PROFILE: profile, PANLITE_UI_QUICK: quick ? '1' : '0', PANLITE_UI_AI_DARK: aiDark ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [join(root, 'scripts/fixtures/ui-visual-main.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''
    child.stdout.on('data', chunk => { process.stdout.write(chunk); diagnostic = (diagnostic + chunk).slice(-12000) })
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-12000) })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`UI visual smoke timeout\n${diagnostic}`)) }, 240000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolveRun()
      else reject(new Error(`UI visual smoke exited ${code}\n${diagnostic}`))
    })
  })
  const reportPath = join(output, 'report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  function rendererFiles(base, relative = '') {
    return readdirSync(join(base, relative), { withFileTypes: true }).flatMap(item => item.isDirectory() ? rendererFiles(base, join(relative, item.name)) : [join(relative, item.name)])
  }
  const currentRenderer = join(root, 'src/renderer'), snapshotRenderer = join(snapshot, 'src/renderer')
  const allFiles = [...new Set([...rendererFiles(currentRenderer), ...rendererFiles(snapshotRenderer)])]
  const differences = allFiles.filter(file => !existsSync(join(currentRenderer, file)) || !existsSync(join(snapshotRenderer, file)) || !readFileSync(join(currentRenderer, file)).equals(readFileSync(join(snapshotRenderer, file))))
  report.sourceSnapshot = { rendererFilesChecked: allFiles.length, consistentWithCurrentSource: differences.length === 0, differences }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (differences.length) throw new Error(`Renderer source changed during visual QA: ${differences.join(', ')}`)
  console.log(`Visual report: ${reportPath}`)
} finally { await server.close() }
