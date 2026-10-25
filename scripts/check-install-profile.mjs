import { spawnSync } from 'node:child_process'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const [action, executable, profile, output, manifest] = process.argv.slice(2)
if (!['seed', 'verify', 'launch'].includes(action) || !executable || !profile || !output) throw new Error('Expected seed|verify|launch, executable, isolated profile, output and optional manifest')
const isolatedRoot = dirname(resolve(profile))
if (dirname(isolatedRoot) !== resolve(tmpdir()) || !/^panlite-install-smoke-[a-f0-9]{32}$/.test(basename(isolatedRoot))) throw new Error('Profile must belong to the disposable installation test directory')
if (await realpath(isolatedRoot) !== join(await realpath(tmpdir()), basename(isolatedRoot))) throw new Error('Disposable installation root must not be a junction or symbolic link')
try { if ((await lstat(profile)).isSymbolicLink()) throw new Error('Isolated profile must not be a junction or symbolic link') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const env = { ...process.env }
delete env.VITE_DEV_SERVER_URL
let args
if (action === 'launch') {
  await mkdir(dirname(resolve(output)), { recursive: true })
  await rm(resolve(output), { force: true })
  env.PANLITE_BENCHMARK_USER_DATA = resolve(profile)
  env.PANLITE_BENCHMARK_OUTPUT = resolve(output)
  // No health checks, transfer queue or automatic model calls are started.
  delete env.ELECTRON_RUN_AS_NODE
  args = ['--benchmark-startup']
} else {
  if (!manifest) throw new Error('Profile fixture manifest is required')
  env.ELECTRON_RUN_AS_NODE = '1'
  args = [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/install-profile.cjs'), action, resolve(executable), resolve(profile), resolve(manifest)]
}
const result = spawnSync(resolve(executable), args, { env, cwd: dirname(resolve(executable)), windowsHide: true,
  encoding: 'utf8', timeout: action === 'launch' ? 60_000 : 30_000, maxBuffer: 1024 * 1024 })
if (result.error || result.status !== 0) {
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(`${output}.log`, `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`)
  throw new Error(`Installed profile ${action} failed: ${result.error || result.stderr || result.stdout || result.status}`)
}
if (action === 'launch') {
  const report = JSON.parse(await readFile(output, 'utf8'))
  if (report.error || !report.renderer?.textLength || !report.version) throw new Error('Installed application did not produce a valid startup report')
  console.log(`Installed application ${report.version} launched with the isolated profile`)
} else {
  const report = JSON.parse(result.stdout.trim())
  if (!report.passed) throw new Error('Installed profile check did not pass')
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Installed profile ${action}: passed`)
}
