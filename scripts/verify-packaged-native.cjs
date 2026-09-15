const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

// Verify the binary that will ship, using the packaged Electron runtime. A
// successful rebuild command alone cannot detect a stale native build marker.
// Run after executable resources/signing are complete: launching the EXE from
// afterPack can keep it locked while Windows resource editing is still pending.
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const binding = path.join(context.appOutDir, 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  const loader = require.resolve('better-sqlite3')
  const script = `const Database = require(${JSON.stringify(loader)});
    const db = new Database(':memory:', { nativeBinding: ${JSON.stringify(binding)} });
    if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite probe failed');
    db.close(); console.log('Packaged SQLite verified with Electron ABI ' + process.versions.modules);`
  const result = spawnSync(executable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error(`Packaged SQLite cannot load: ${result.error || result.stderr || result.stdout}`)
  }
  console.log(result.stdout.trim())
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
    console.log('Packaged 7zip executable verified: create, list and exact-byte extraction')
  } finally {
    rmSync(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
