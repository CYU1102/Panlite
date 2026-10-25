import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, process.argv[2] || 'output/inline-login-smoke')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'panlite-inline-login-smoke-'))
const entry = resolve(root, 'dist/inline-login-smoke/main.cjs')
await build({ entryPoints: [resolve(root, 'scripts/fixtures/inline-login-smoke.ts')], outfile: entry,
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
const env = { ...process.env, PANLITE_INLINE_SMOKE_PROFILE: profile, PANLITE_INLINE_SMOKE_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
try {
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-16000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Inline login smoke timed out\n${diagnostics}`)) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(new Error(`Inline login smoke exited ${code}\n${diagnostics}`)) })
  })
  console.log(await readFile(join(output, 'report.json'), 'utf8'))
} finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
