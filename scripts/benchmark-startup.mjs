import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'
import reportTools from './benchmark-report.cjs'

const root = resolve(import.meta.dirname, '..')
const argumentsList = process.argv.slice(2)
const baselineAt = argumentsList.indexOf('--baseline')
const baselinePath = baselineAt >= 0 ? argumentsList[baselineAt + 1] : undefined
if (baselineAt >= 0 && (!baselinePath || baselinePath.startsWith('--'))) throw new Error('--baseline needs a file path')
if (baselineAt >= 0) argumentsList.splice(baselineAt, 2)
const baseline = reportTools.readBaseline(baselinePath)
const runs = Number(argumentsList[0] || 3)
const packagedApp = argumentsList[1] ? resolve(argumentsList[1]) : null
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Runs must be an integer from 1 to 20')
const reports = resolve(root, argumentsList[2] || 'dist/reports')
if (baselinePath && resolve(baselinePath) === join(reports, 'startup-benchmark.json')) throw new Error('Use a separate reports directory to preserve the previous candidate baseline')
const provenance = reportTools.metadata(root, {
  version: 'startup-fixed-v2', runs, runtime: packagedApp ? 'packaged' : 'source-build', profile: 'new-empty-profile-every-run',
  theme: process.env.PANLITE_BENCHMARK_THEME ?? 'default', width: process.env.PANLITE_BENCHMARK_WIDTH ?? 'default',
  route: process.env.PANLITE_BENCHMARK_ROUTE ?? 'default', action: process.env.PANLITE_BENCHMARK_ACTION ?? null,
  suite: process.env.PANLITE_BENCHMARK_SUITE ?? null,
  toolsConfigSha256: process.env.PANLITE_BENCHMARK_TOOLS_CONFIG ? reportTools.sha256(process.env.PANLITE_BENCHMARK_TOOLS_CONFIG) : null,
  importFixturesSha256: process.env.PANLITE_BENCHMARK_IMPORT_FIXTURES ? reportTools.sha256(process.env.PANLITE_BENCHMARK_IMPORT_FIXTURES) : null,
}, ['scripts/benchmark-startup.mjs', 'scripts/benchmark-report.cjs', 'src/main/startup-benchmark.ts', 'src/main/window.ts', 'package.json', 'package-lock.json'])
let packagedArtifact = null
if (packagedApp) {
  let buildProvenance = null
  try { buildProvenance = JSON.parse(await readFile(join(dirname(packagedApp), '../build-provenance.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  packagedArtifact = {
    executableSha256: reportTools.sha256(await readFile(packagedApp)),
    archiveSha256: reportTools.sha256(await readFile(join(dirname(packagedApp), 'resources/app.asar'))),
    buildProvenance,
    sourceAttribution: buildProvenance ? 'Source snapshot supplied alongside the packaged candidate; archive and executable hashes identify the measured bytes.' : 'No packaged source manifest supplied. Workspace source hashes describe the benchmark harness, not the packaged application.',
  }
}
await mkdir(reports, { recursive: true })
const results = []
await rm(join(reports, 'startup-benchmark.json'), { force: true })
for (let index = 0; index < runs; index++) {
  const profile = await mkdtemp(join(tmpdir(), 'panlite-startup-bench-'))
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('panlite-startup-bench-')) {
    throw new Error('Startup benchmark profile must remain inside its temporary directory')
  }
  const output = join(reports, `startup-${index + 1}.json`)
  const started = performance.now()
  let succeeded = false
  let diagnostics = ''
  try {
    await rm(output, { force: true })
    await rm(output.replace(/\.json$/, '.png'), { force: true })
    await rm(output.replace(/\.json$/, '.log'), { force: true })
    const env = { ...process.env, PANLITE_BENCHMARK_USER_DATA: profile, PANLITE_BENCHMARK_OUTPUT: output }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.VITE_DEV_SERVER_URL
    await new Promise((resolveRun, reject) => {
      const child = spawn(packagedApp || electron, packagedApp ? ['--benchmark-startup'] : [root, '--benchmark-startup'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-128_000) }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 45_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        if (timedOut) reject(new Error('Startup benchmark timed out after 45 seconds'))
        else if (code === 0) resolveRun()
        else reject(new Error(`Electron exited with code ${code}; inspect ${output}`))
      })
    })
    const report = JSON.parse(await readFile(output, 'utf8'))
    if (report.error) throw new Error(report.error)
    results.push({ ...report, processWallMs: performance.now() - started })
    console.log(`Run ${index + 1}: renderer first screen ${report.renderer.firstScreenMs.toFixed(1)} ms; main ready ${report.readyMs.toFixed(1)} ms`)
    succeeded = true
  } catch (error) {
    await writeFile(output.replace(/\.json$/, '.log'), diagnostics)
    console.error(`Startup diagnostics: ${output.replace(/\.json$/, '.log')}; isolated profile retained: ${profile}`)
    throw error
  } finally {
    if (succeeded) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 }
const summary = { schema: 2, benchmark: 'isolated-startup', recordedAt: new Date().toISOString(), ...provenance,
  packagedArtifact,
  environment: { ...provenance.environment, appElectron: results[0]?.electron ?? null, appNode: results[0]?.node ?? null, appModuleAbi: results[0]?.moduleAbi ?? null, appChrome: results[0]?.chrome ?? null },
  scenario: 'fresh isolated profile, background services disabled', runs: results,
  medianReadyMs: median(results.map(row => row.readyMs)), medianFirstScreenMs: median(results.map(row => row.renderer.firstScreenMs)),
  timings: { ready: reportTools.statistics(results.map(row => row.readyMs)), firstScreen: reportTools.statistics(results.map(row => row.renderer.firstScreenMs)), processWall: reportTools.statistics(results.map(row => row.processWallMs)) },
  verification: { allWindowsHiddenAtVerification: results.every(row => row.hiddenAtVerification === true), mainProcessMemorySamples: results.map(row => row.mainProcessMemory ?? null), completeRuntimeEvidence: results.every(row => row.electron && row.node && row.moduleAbi && row.chrome) },
  limits: ['Fresh profiles do not evict OS filesystem caches. This is not a cold-cache startup guarantee.', 'Machine/runtime/fixture must match the supplied earlier candidate; absent or incompatible baselines cannot support a speedup claim.'],
}
summary.comparison = reportTools.compareReports(summary, baseline, ['medianReadyMs', 'medianFirstScreenMs', 'timings.processWall.p95Ms'])
await writeFile(join(reports, 'startup-benchmark.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(`Candidate comparison: ${summary.comparison.status}`)
