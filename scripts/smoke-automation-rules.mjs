import { cp, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import electron from 'electron'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'output', 'automation-rules-smoke')
const isolated = await mkdtemp(path.join(tmpdir(), 'panlite-automation-rules-smoke-'))
const main = path.join(isolated, 'dist', 'main', 'main'), profile = path.join(isolated, 'profile')
const binding = process.env.PANLITE_ELECTRON_SQLITE_BINDING || path.join(root, 'release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
const checked = path.resolve(isolated)
if (path.dirname(checked) !== path.resolve(tmpdir()) || !path.basename(checked).startsWith('panlite-automation-rules-smoke-')) throw new Error('Unsafe smoke cleanup path')
let succeeded = false
try {
  await mkdir(output, { recursive: true }); await mkdir(main, { recursive: true }); await mkdir(profile, { recursive: true })
  // The released Electron binding is copied into a private module tree; shared
  // dependencies and the application's real profile remain untouched.
  await cp(path.join(root, 'node_modules/better-sqlite3'), path.join(isolated, 'node_modules/better-sqlite3'), { recursive: true })
  for (const name of ['bindings', 'file-uri-to-path']) await cp(path.join(root, 'node_modules', name), path.join(isolated, 'node_modules', name), { recursive: true })
  await copyFile(binding, path.join(isolated, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'))
  await cp(path.join(root, 'dist/renderer'), path.join(isolated, 'dist/renderer'), { recursive: true })
  await build({ entryPoints: [path.join(root, 'src/main/preload.ts')], outfile: path.join(main, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const entry = path.join(main, 'automation-rules-smoke.cjs')
  await build({ entryPoints: [path.join(root, 'scripts/fixtures/automation-rules-smoke.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', banner: { js: `module.paths.push(${JSON.stringify(path.join(root, 'node_modules'))});` } })
  const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules'), PANLITE_AUTOMATION_SMOKE_PROFILE: profile, PANLITE_AUTOMATION_SMOKE_OUTPUT: output }
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''
    const collect = bytes => { diagnostic = (diagnostic + bytes).slice(-24_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Automation runtime timed out\n${diagnostic}`)) }, 180_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(new Error(`Automation runtime exited ${code}\n${diagnostic}`)) })
  })
  console.log(await readFile(path.join(output, 'report.json'), 'utf8')); succeeded = true
} finally {
  if (succeeded) await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  else console.error(`Failed smoke profile retained for diagnosis: ${checked}`)
}
