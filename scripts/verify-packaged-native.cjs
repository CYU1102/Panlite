const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')

// Verify the binary that will ship, using the packaged Electron runtime. A
// successful rebuild command alone cannot detect a stale native build marker.
// Run after executable resources/signing are complete: launching the EXE from
// afterPack can keep it locked while Windows resource editing is still pending.
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const binding = path.join(context.appOutDir, 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  const archive = path.join(context.appOutDir, 'resources/app.asar')
  const script = `const packagedRequire = require('node:module').createRequire(${JSON.stringify(path.join(archive, 'package.json'))});
    const Database = packagedRequire('better-sqlite3');
    const db = new Database(':memory:');
    if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite probe failed');
    db.close(); console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
      abi: process.versions.modules, sqliteModuleVersion: packagedRequire('better-sqlite3/package.json').version,
      loaderPath: packagedRequire.resolve('better-sqlite3'), hostDependencyFallbackAllowed: false }));`
  const result = spawnSync(executable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error(`Packaged SQLite cannot load: ${result.error || result.stderr || result.stdout}`)
  }
  const runtime = JSON.parse(result.stdout.trim())
  if (!path.resolve(runtime.loaderPath).startsWith(path.resolve(archive) + path.sep)) throw new Error('SQLite loader resolved outside the packaged application')
  const reportPath = path.join(path.dirname(context.appOutDir), 'packaged-native-verification.json')
  const report = { createdAt: new Date().toISOString(), passed: false, runtime,
    sqlite: { passed: true, bindingSha256: createHash('sha256').update(readFileSync(binding)).digest('hex') }, sevenZip: { passed: false } }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`Packaged SQLite verified with Electron ABI ${runtime.abi}`)
  const sevenZip = path.join(context.appOutDir, 'resources/app.asar.unpacked/node_modules/7zip-bin/win/x64/7za.exe')
  const directory = mkdtempSync(path.join(tmpdir(), 'panlite-packaged-7zip-'))
  const checked = path.resolve(directory)
  if (path.dirname(checked) !== path.resolve(tmpdir()) || !path.basename(checked).startsWith('panlite-packaged-7zip-')) throw new Error('Unsafe packaged 7zip verification path')
  const original = Buffer.from('PanLite packaged 7zip verification / 中文字节校验\n', 'utf8')
  try {
    writeFileSync(path.join(directory, 'sample.txt'), original)
    const run = args => {
      const probe = spawnSync(sevenZip, args, { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 15_000 })
      if (probe.status !== 0) throw new Error(`Packaged 7zip cannot run: ${probe.error || probe.stderr || probe.stdout}`)
      return probe.stdout
    }
    run(['a', '-t7z', 'sample.7z', 'sample.txt', '-y'])
    if (!run(['l', '-slt', 'sample.7z']).includes('Path = sample.txt')) throw new Error('Packaged 7zip did not list the expected file')
    run(['x', 'sample.7z', '-oextracted', '-y'])
    if (!readFileSync(path.join(directory, 'extracted', 'sample.txt')).equals(original)) throw new Error('Packaged 7zip extraction changed file bytes')
    report.sevenZip = { passed: true, executableSha256: createHash('sha256').update(readFileSync(sevenZip)).digest('hex'), createListExtractExactBytes: true }
    report.passed = true
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log('Packaged 7zip executable verified: create, list and exact-byte extraction')
  } finally {
    rmSync(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (require.main === module) {
  const appOutDir = path.resolve(process.argv[2] || 'release/win-unpacked')
  const productFilename = process.argv[3] || 'PanLite'
  module.exports({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename } } })
    .catch(error => { console.error(error); process.exitCode = 1 })
}
