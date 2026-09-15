#!/usr/bin/env node
// better-sqlite3 的原生二进制只能针对一个 ABI 生效:
// Vitest 跑在系统 Node 下,而应用运行在 Electron 下,两者 ABI 不同。
// 本脚本通过 prebuild-install 下载对应运行时的预编译二进制完成切换,
// 并用 node_modules 内的标记文件避免重复下载。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const target = process.argv[2]
if (target !== 'node' && target !== 'electron') {
  console.error('Usage: node scripts/rebuild-native.mjs <node|electron>')
  process.exit(1)
}

const require = createRequire(import.meta.url)
const moduleDir = path.dirname(require.resolve('better-sqlite3/package.json'))
const markerPath = path.join(moduleDir, '.panlite-abi-target')
const runtimeVersion = target === 'node'
  ? process.version.replace(/^v/, '')
  : require('electron/package.json').version
const bindingPath = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node')
const moduleVersion = require(path.join(moduleDir, 'package.json')).version
const markerPrefix = `${target}:${runtimeVersion}:${process.platform}:${process.arch}:${moduleVersion}`
function bindingMarker() {
  if (!existsSync(bindingPath)) return null
  const digest = createHash('sha256').update(readFileSync(bindingPath)).digest('hex')
  return `${markerPrefix}:${digest}`
}

// electron-builder/install-app-deps may replace the binary without updating
// our marker. Verify its digest as well as the target before skipping work.
const existingMarker = bindingMarker()
// prebuild-install replaces the binding but leaves Electron Rebuild's marker
// behind. Otherwise a later direct electron-builder invocation may skip rebuilding.
if (target === 'node') {
  rmSync(path.join(moduleDir, 'build', 'Release', '.forge-meta'), { force: true })
}
if (existingMarker && existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === existingMarker) {
  console.log(`better-sqlite3 already built for ${target} ${runtimeVersion}, skipping`)
  process.exit(0)
}

const rootDir = path.resolve(moduleDir, '..', '..')
const rebuildArgs = target === 'electron'
  ? [
      path.join(path.dirname(require.resolve('@electron/rebuild')), 'cli.js'),
      '--version', runtimeVersion,
      '--module-dir', rootDir,
      '--only', 'better-sqlite3',
      '--force',
    ]
  : [
      require.resolve('prebuild-install/bin.js', { paths: [moduleDir] }),
      '--runtime', target,
      '--target', runtimeVersion,
    ]
const result = spawnSync(
  process.execPath,
  rebuildArgs,
  { cwd: target === 'electron' ? rootDir : moduleDir, stdio: 'inherit' }
)

if (result.status !== 0) {
  rmSync(markerPath, { force: true })
  console.error(`Failed to install better-sqlite3 prebuild for ${target} ${runtimeVersion}`)
  process.exit(result.status ?? 1)
}

const marker = bindingMarker()
if (!marker) throw new Error(`Native rebuild did not produce ${bindingPath}`)
writeFileSync(markerPath, `${marker}\n`)
console.log(`better-sqlite3 switched to ${target} (v${runtimeVersion})`)
