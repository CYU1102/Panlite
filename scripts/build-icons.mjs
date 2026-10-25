import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electron, [resolve(import.meta.dirname, 'build-icons.cjs')], {
  env, stdio: 'inherit', windowsHide: true, timeout: 30_000,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
