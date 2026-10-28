import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' || !process.env.RUNNER_TEMP) throw new Error('Isolated Windows runner required')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const scratch = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'panlite-credential-smoke-'))
const entry = path.join(scratch, 'fixture.cjs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  await build({ entryPoints: [path.join(root, 'scripts/fixtures/credential-durability-smoke.ts')], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    banner: { js: `module.paths.push(${JSON.stringify(path.join(root, 'node_modules'))});` } })
  for (const scenario of ['protected', 'legacy']) {
    const profile = path.join(scratch, scenario)
    mkdirSync(profile)
    for (const mode of ['write', 'read']) {
      const result = spawnSync(require('electron'), [entry, mode, profile, scenario], { env, encoding: 'utf8', windowsHide: true, timeout: 40000 })
      if (result.error || result.status !== 0) throw new Error(`Credential ${scenario}/${mode} failed: ${result.error?.message || result.stderr}`)
    }
  }
  console.log('Protected account, setting and URL survived forced exit; legacy formats survived normal restart')
} finally { rmSync(scratch, { recursive: true, force: true }) }
