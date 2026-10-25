import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'output/live-acceptance-20260909')
const originalProfile = 'C:/Users/27199/AppData/Roaming/panlite'
const native = resolve(root, 'release-next-ocr-20260909/verified/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'panlite-live-quark-'))
try {
  const originalState = JSON.parse(await readFile(join(originalProfile, 'Local State'), 'utf8'))
  if (!originalState.os_crypt) throw new Error('Encrypted key envelope unavailable')
  await writeFile(join(profile, 'Local State'), JSON.stringify({ os_crypt: originalState.os_crypt }))
  const entry = join(profile, 'quark-readonly-driver.cjs')
  await build({ entryPoints: [resolve(root, 'scripts/fixtures/quark-pagination-retest.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    banner: { js: `module.paths.unshift(${JSON.stringify(join(root, 'node_modules'))});` } })
  const bootstrap = join(profile, 'start.cjs')
  await writeFile(bootstrap, `const {app}=require('electron');
const {writeFileSync}=require('node:fs');
const fail=(error)=>{writeFileSync(${JSON.stringify(join(output, 'quark-pagination-retest.json'))},JSON.stringify({failure:'driver-startup-failed',code:typeof error?.code==='string'?error.code:undefined,dependency: /Cannot find module '(better-sqlite3|electron-log|electron)'/.exec(String(error?.message))?.[1],startedAt:new Date().toISOString(),safety:{windowsCreated:0,providerRequestsStarted:false}},null,2));app.exit(1)};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
try{require(${JSON.stringify(entry)})}catch(error){fail(error)};
`)
  const env = { ...process.env, PANLITE_READONLY_PROFILE: profile, PANLITE_READONLY_OUTPUT: output, PANLITE_READONLY_REPORT: join(output, 'quark-pagination-retest.json'),
    PANLITE_READONLY_DATABASE: join(originalProfile, 'panlite.db'), PANLITE_READONLY_NATIVE: native,
    PANLITE_READONLY_PREVIOUS_METADATA: join(root, 'output/quark-live-acceptance/bounded-metadata-samples.json'),
    NODE_PATH: join(root, 'node_modules') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [bootstrap, ...process.argv.slice(2).filter(value => ['--continue-shares', '--verify-second-page'].includes(value))], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Read-only acceptance process timed out')) }, 75_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Read-only acceptance failed to start')) })
    child.once('exit', code => { clearTimeout(timer); resolveRun(code ?? 1) })
  })
  console.log(`Read-only acceptance exited ${code}; report: output/live-acceptance-20260909/quark-pagination-retest.json`)
  process.exitCode = Number(code)
} finally {
  const checked = resolve(profile)
  if (dirname(checked) === resolve(tmpdir()) && basename(checked).startsWith('panlite-live-quark-')) {
    await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    const removed = await access(checked).then(() => false, () => true)
    const reportPath = join(output, 'quark-pagination-retest.json')
    try {
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      report.safety.isolatedProfilePathValidated = true
      report.safety.isolatedProfileRemoved = removed
      await writeFile(reportPath, JSON.stringify(report, null, 2))
    } catch {}
  }
}
