import { createServer } from 'vite'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, copyFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const renderer = process.argv[2] === '--renderer' && process.argv[3] ? resolve(process.argv[3]) : ''
const output = join(root, 'output/ai-workflow-smoke', renderer ? 'production' : 'development')
const profile = await mkdtemp(join(tmpdir(), 'panlite-ai-workflow-smoke-'))
await mkdir(output, { recursive: true })
let server
function run(binary, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let diagnostic = ''
    child.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-18000) })
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-18000) })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`AI smoke timed out\n${diagnostic}`)) }, 55000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolveRun(diagnostic); else reject(new Error(`AI smoke exited ${code}\n${diagnostic}`)) })
  })
}
try {
  const moduleDir = join(profile, 'better-sqlite3')
  await mkdir(moduleDir)
  await copyFile(require.resolve('better-sqlite3/package.json'), join(moduleDir, 'package.json'))
  const electronVersion = require('electron/package.json').version
  const binding = join(moduleDir, 'build/Release/better_sqlite3.node')
  const originalBinding = join(dirname(require.resolve('better-sqlite3/package.json')), 'build/Release/better_sqlite3.node')
  await mkdir(dirname(binding), { recursive: true })
  await copyFile(originalBinding, binding)
  const nativeProbe = `const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))}); const db = new Database(':memory:', { nativeBinding: ${JSON.stringify(binding)} }); db.prepare('SELECT 1').get(); db.close();`
  const copiedBindingWorks = await run(electron, ['-e', nativeProbe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).then(() => true, () => false)
  if (!copiedBindingWorks) {
  const electronAbi = (await run(electron, ['-p', 'process.versions.modules'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })).trim()
  if (!/^\d+$/.test(electronAbi)) throw new Error('Unable to detect isolated Electron ABI')
  const install = join(profile, 'install-binding.cjs')
  const prebuild = require.resolve('prebuild-install/bin.js')
  await writeFile(install, `const abi = require(${JSON.stringify(require.resolve('node-abi'))}); const original = abi.getAbi; abi.getAbi = (target, runtime) => runtime === 'electron' && target === ${JSON.stringify(electronVersion)} ? ${JSON.stringify(electronAbi)} : original(target, runtime); process.argv = [process.execPath, ${JSON.stringify(prebuild)}, '--runtime', 'electron', '--target', ${JSON.stringify(electronVersion)}]; require(${JSON.stringify(prebuild)});`)
  await run(process.execPath, [install], { cwd: moduleDir })
  }
  const entry = join(output, 'main.cjs'), bootstrap = join(output, 'bootstrap.cjs')
  await build({ entryPoints: [join(root, 'scripts/fixtures/ai-workflow-smoke.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  await build({ entryPoints: [join(root, 'scripts/fixtures/ai-workflow-smoke-preload.ts')], outfile: join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await writeFile(bootstrap, `const Module = require('node:module'); const path = require('node:path'); const native = Module._extensions['.node']; Module._extensions['.node'] = function(mod, file) { return native(mod, path.resolve(file).toLowerCase() === ${JSON.stringify(resolve(originalBinding).toLowerCase())} ? ${JSON.stringify(binding)} : file); }; require(${JSON.stringify(entry)});`)
  let url = ''
  if (!renderer) {
  server = await createServer({ configFile: join(root, 'vite.config.ts'), cacheDir: join(profile, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-ai-workflow-harness',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__ai-smoke') { next(); return }
        response.setHeader('Content-Type', 'text/html')
        response.end(await vite.transformIndexHtml('/__ai-smoke', '<html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module">import {createApp} from "vue"; import Workspace from "/pages/AiWorkspace.vue"; import "/styles/tokens.css"; createApp(Workspace).mount("#app");</script></body></html>'))
      })
    },
  }] })
  await server.listen()
  const address = server.httpServer.address()
  url = `http://127.0.0.1:${address.port}`
  }
  const env = { ...process.env, VITE_DEV_SERVER_URL: url, PANLITE_AI_SMOKE_PROFILE: profile, PANLITE_AI_SMOKE_OUTPUT: output, PANLITE_AI_SMOKE_RENDERER: renderer }
  delete env.ELECTRON_RUN_AS_NODE
  await run(electron, [bootstrap], { env })
  console.log(await readFile(join(output, 'report.json'), 'utf8'))
} finally {
  await server?.close()
  const checked = resolve(profile)
  if (dirname(checked) === resolve(tmpdir()) && basename(checked).startsWith('panlite-ai-workflow-smoke-')) await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
