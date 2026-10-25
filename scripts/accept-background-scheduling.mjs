import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..'), output = join(root, 'output/live-acceptance-20260909')
const profile = await mkdtemp(join(tmpdir(), 'panlite-live-scheduling-'))
if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('panlite-live-scheduling-')) throw new Error('Unexpected cleanup path')
try {
  await mkdir(output, { recursive: true })
  const entry = join(output, 'scheduling-driver.cjs')
  await build({ entryPoints: [join(root, 'scripts/fixtures/background-scheduling-acceptance.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const env = { ...process.env, PANLITE_SCHEDULING_PROFILE: profile, PANLITE_SCHEDULING_OUTPUT: output }
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [entry], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Background scheduling acceptance timed out')) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', value => { clearTimeout(timer); resolveRun(value) })
  })
  console.log(await readFile(join(output, 'scheduling-report.json'), 'utf8'))
  process.exitCode = code === 0 ? 0 : 1
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
