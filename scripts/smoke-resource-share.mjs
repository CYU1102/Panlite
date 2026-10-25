import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, process.argv[2] || 'output/resource-share-smoke')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'panlite-resource-share-smoke-'))
const outdir = resolve(root, 'dist/resource-share-smoke')
await build({ entryPoints: { main: resolve(root, 'scripts/fixtures/resource-share-smoke.ts'), preload: resolve(root, 'src/main/preload.ts') }, outdir,
  outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
const env = { ...process.env, PANLITE_RESOURCE_SMOKE_PROFILE: profile, PANLITE_RESOURCE_SMOKE_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
try {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [join(outdir, 'main.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-16000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Resource share smoke timed out\n${diagnostics}`)) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(new Error(`Resource share smoke exited ${code}\n${diagnostics}`)) })
  })
  console.log(await readFile(join(output, 'report.json'), 'utf8'))
} finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
