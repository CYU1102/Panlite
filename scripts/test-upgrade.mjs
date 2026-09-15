import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

// Shared work can build an Electron package while Node tests run. Give every
// test process an independent native binary, including forked crash fixtures.
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const isolated = await mkdtemp(path.join(tmpdir(), 'panlite-upgrade-tests-'))
const moduleDir = path.join(isolated, 'better-sqlite3')
const bootstrap = path.join(isolated, 'native.cjs')
const binding = path.join(moduleDir, 'build/Release/better_sqlite3.node')
async function run(args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options })
    child.once('error', reject)
    child.once('exit', code => resolveRun(code ?? 1))
  })
}
try {
  await mkdir(moduleDir)
  await copyFile(require.resolve('better-sqlite3/package.json'), path.join(moduleDir, 'package.json'))
  const install = await run([require.resolve('prebuild-install/bin.js'), '--runtime', 'node', '--target', process.versions.node], { cwd: moduleDir })
  if (install !== 0) throw new Error('Unable to prepare an isolated Node SQLite binding')
  const originalBinding = path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'build/Release/better_sqlite3.node')
  await writeFile(bootstrap, `const Module = require('node:module');
const path = require('node:path');
const loadNative = Module._extensions['.node'];
Module._extensions['.node'] = function(module, filename) {
  const selected = path.resolve(filename).toLowerCase() === ${JSON.stringify(path.resolve(originalBinding).toLowerCase())}
    ? ${JSON.stringify(binding)} : filename;
  return loadNative(module, selected);
};
`)
  const nodeOptions = [process.env.NODE_OPTIONS || '', `--require=${JSON.stringify(bootstrap.replaceAll('\\', '/'))}`].filter(Boolean).join(' ')
  const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const status = await run([vitest, 'run', ...process.argv.slice(2)], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  })
  process.exitCode = status
} finally {
  const checked = path.resolve(isolated)
  if (path.dirname(checked) === path.resolve(tmpdir()) && path.basename(checked).startsWith('panlite-upgrade-tests-')) {
    await rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
