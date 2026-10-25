import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'output/quark-live-acceptance')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'panlite-quark-readonly-'))
try {
// Chromium's Windows key remains DPAPI-encrypted. Copy only its envelope, never
// database credentials or the original profile's preferences/session contents.
const originalState = JSON.parse(await readFile('C:/Users/27199/AppData/Roaming/panlite/Local State', 'utf8'))
if (!originalState.os_crypt) throw new Error('Original encrypted key envelope is unavailable')
await writeFile(join(profile, 'Local State'), JSON.stringify({ os_crypt: originalState.os_crypt }))
const entry = join(output, 'readonly-driver.cjs')
await build({ entryPoints: [resolve(root, 'scripts/fixtures/quark-readonly-live.ts')], outfile: entry,
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
const env = { ...process.env, PANLITE_QUARK_LIVE_PROFILE: profile, PANLITE_QUARK_LIVE_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
  await new Promise((resolveRun, reject) => {
    const child = spawn(electron, [entry, ...process.argv.slice(2).filter(value => ['--list-only', '--compare-stacks', '--diagnostics', '--metadata', '--full-acceptance', '--media-only', '--extra-samples', '--fallback-samples', '--search-get-test', '--search-q-test', '--production-search-samples'].includes(value))],
      { cwd: root, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Read-only driver timed out; inspect sanitized reports')) }, 120_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Read-only driver failed to start')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else reject(new Error('Read-only driver failed; inspect sanitized reports'))
    })
  })
  console.log('Read-only driver finished. Sanitized reports: output/quark-live-acceptance')
} finally {
  // mkdtemp returned this owned directory, never a user-supplied or discovered path.
  if (dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('panlite-quark-readonly-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
