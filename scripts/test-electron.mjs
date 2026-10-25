import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

// Run tests against the application's actual Node/SQLite ABI without replacing
// a native binding another build or test process may currently be using.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const child = spawn(require('electron'), [vitest, 'run', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true,
  stdio: 'inherit',
})
child.once('error', error => { console.error(`Electron test runner: ${error.message}`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
