import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' || !process.env.RUNNER_TEMP) throw new Error('Isolated Windows runner required')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const scratch = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'panlite-key-diagnostic-'))
const entry = path.join(scratch, 'fixture.cjs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  await build({ entryPoints: [path.join(root, 'scripts/fixtures/archive-key-diagnostic.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const result = []
  for (const [method, shutdown] of [['sync', 'force'], ['sync', 'wait'], ['async', 'force'], ['async', 'wait'], ['sync', 'normal']]) {
    const profileRoot = path.join(scratch, `${method}-${shutdown}`)
    mkdirSync(profileRoot)
    const run = operation => spawnSync(require('electron'), [entry, operation, profileRoot, method, shutdown], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const write = run('write')
    if (write.error || write.status !== 0) throw new Error(`Diagnostic ${method}/${shutdown} write failed: ${write.error?.message || write.stderr}`)
    const read = run('read')
    if (read.error || read.status !== 0) throw new Error(`Diagnostic ${method}/${shutdown} read failed: ${read.error?.message || read.stderr}`)
    const row = { method, shutdown, ...JSON.parse(read.stdout.trim()) }
    result.push(row)
    console.log(JSON.stringify(row))
  }
  mkdirSync(path.join(root, 'dist/reports'), { recursive: true })
  writeFileSync(path.join(root, 'dist/reports/archive-key-diagnostic.json'), JSON.stringify(result, null, 2) + '\n')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
