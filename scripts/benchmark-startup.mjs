import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const runs = Number(process.argv[2] || 3)
const packagedApp = process.argv[3] ? resolve(process.argv[3]) : null
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Runs must be an integer from 1 to 20')
const reports = resolve(root, process.argv[4] || 'dist/reports')
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
const summary = { scenario: 'fresh isolated profile, background services disabled', runs: results,
  medianReadyMs: median(results.map(row => row.readyMs)), medianFirstScreenMs: median(results.map(row => row.renderer.firstScreenMs)) }
await writeFile(join(reports, 'startup-benchmark.json'), JSON.stringify(summary, null, 2) + '\n')
