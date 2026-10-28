import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Electron is launched only in the isolated GitHub-hosted Windows runner.
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' || !process.env.RUNNER_TEMP) {
  throw new Error('This isolated smoke test requires the GitHub-hosted Windows runner')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'panlite-password-smoke-'))
const entry = path.join(directory, 'smoke.cjs')
try {
  await build({ entryPoints: [path.join(root, 'scripts/fixtures/archive-password-smoke.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    banner: { js: `module.paths.push(${JSON.stringify(path.join(root, 'node_modules'))});` } })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const shutdown of ['normal', 'force']) {
    const isolated = path.join(directory, shutdown)
    mkdirSync(isolated)
    for (const mode of ['write', 'read']) {
      const result = spawnSync(require('electron'), [entry, mode, isolated, shutdown], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
      if (result.error || result.status !== 0) throw new Error(`Protected password ${shutdown}/${mode} failed: ${result.error?.message || result.stderr}`)
    }
  }
  console.log('Windows-protected archive passwords survived normal and forced isolated process exits')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
