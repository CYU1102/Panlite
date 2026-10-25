const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const output = path.resolve(process.argv[2] || 'release')
const executable = path.join(output, 'win-unpacked/PanLite.exe')
const archive = path.join(output, 'win-unpacked/resources/app.asar')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-package-imports-'))
if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('panlite-package-imports-')) throw new Error('Unexpected owned temporary directory')
const imports = ['better-sqlite3', 'archiver', 'node-7z', '7zip-bin', 'node-unrar-js', 'pdf2json', 'tar', 'unzipper', 'electron-updater']
const probe = `
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const archive = ${JSON.stringify(archive)}, temp = ${JSON.stringify(temp)};
const originalResolve = Module._resolveFilename, originalLoad = Module._load;
Module._resolveFilename = function(...args) {
  const resolved = originalResolve.apply(this, args);
  if (typeof resolved === 'string' && !Module.isBuiltin(resolved)) {
    const absolute = path.resolve(resolved);
    if (!absolute.startsWith(archive + path.sep) && !absolute.startsWith(archive + '.unpacked' + path.sep)) {
      throw new Error('Dependency resolved outside packaged application: ' + args[0]);
    }
  }
  return resolved;
};
// Electron APIs exist in the application runtime. These inert values only let
// module declarations load in RUN_AS_NODE; no updater or app lifecycle is run.
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '0.2.0', getName: () => 'PanLite', getPath: () => temp, on() {}, once() {} }, net: {}, session: {}, ipcMain: { on() {} } };
  return originalLoad.call(this, name, ...args);
};
globalThis.fetch = () => { throw new Error('Network forbidden in import verification'); };
for (const name of ['node:http', 'node:https']) { const module = require(name); module.request = module.get = () => { throw new Error('Network forbidden'); }; }
const packagedRequire = Module.createRequire(path.join(archive, 'package.json'));
const results = [];
for (const name of ${JSON.stringify(imports)}) {
  try { const value = packagedRequire(name); if (name === 'better-sqlite3') { const db = new value(':memory:'); if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite query failed'); db.close(); } results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
console.log(JSON.stringify({ electron: process.versions.electron, abi: process.versions.modules, hostDependencyFallbackAllowed: false, electronLifecycleMockedForImportOnly: true, results }));
if (results.some(result => !result.passed)) process.exitCode = 1;
`
try {
  const result = spawnSync(executable, ['-e', probe], { cwd: temp, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  const line = result.stdout?.trim().split(/\r?\n/).find(line => line.startsWith('{"electron"'))
  if (!line) throw new Error('Packaged import probe did not produce its report')
  const report = JSON.parse(line)
  fs.writeFileSync(path.join(output, 'packaged-import-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ imports: report.results.length, passed: report.results.filter(item => item.passed).length, exitCode: result.status }))
  if (result.status !== 0) process.exitCode = 1
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
