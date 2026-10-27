import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const scenarios = ['cooperative-abort', 'late-success-after-abort']

export function parseArguments(args) {
  const options = { controlled: false, check: false }
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--controlled' || name === '--check') {
      const key = name.slice(2)
      if (options[key]) throw new Error(`Duplicate ${name}`)
      options[key] = true
    } else if (name === '--output' || name === '--baseline') {
      const key = name.slice(2)
      if (options[key]) throw new Error(`Duplicate ${name}`)
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${name} needs a file path`)
      options[key] = resolve(value)
    } else throw new Error(`Unknown option: ${name}`)
  }
  if (options.check && args.length !== 1) throw new Error('--check must be used alone; it never launches a benchmark')
  return options
}

export function createFixture(controlled) {
  const fixture = { version: controlled ? 'task-cancellation-controlled-v1' : 'task-cancellation-fixed-v2', runsPerScenario: controlled ? 30 : 5,
    inputEvidenceProtocol: 'bundle-and-loaded-closure-v1',
    scenarios, fileBytes: 1024 * 1024, firstResponseBytes: 1024, lateCompletionDelayMs: 25, idlePollMs: 1, finalStabilityWaitMs: 30,
    account: 'synthetic-quark', taskType: 'download', conflictPolicy: 'overwrite', originalTarget: 'valuable-original-bytes' }
  if (controlled) Object.assign(fixture, { warmupRounds: 2, ordering: 'Each round runs both scenarios; odd rounds start cooperative, even rounds start late-success. The order restarts for the measured phase.',
    repetitionUnit: 'one Electron Node process; 30 correlated warm-process observations per scenario, not 30 independent processes',
    resourceWindow: 'cancel request through queue-idle observation; the 30ms correctness stability wait is excluded', instrumentation: 'cpu-elu-and-input-closure-v1' })
  return fixture
}

export function plannedRuns(controlled) {
  const plan = []
  if (!controlled) {
    for (const scenario of scenarios) for (let round = 1; round <= 5; round++) plan.push({ id: `${scenario}-${round}`, phase: 'measured', scenario, round })
    return plan
  }
  for (const [phase, rounds] of [['warmup', 2], ['measured', 30]]) {
    for (let round = 1; round <= rounds; round++) {
      const order = round % 2 ? scenarios : [...scenarios].reverse()
      for (const scenario of order) plan.push({ id: `${phase}-${scenario}-${round}`, phase, scenario, round })
    }
  }
  return plan
}

export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function fileEvidence(file, root) {
  const physical = realpathSync.native(file)
  const hash = createHash('sha256'), stream = createReadStream(physical)
  let bytes = 0
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length }
  await finished(stream)
  const withinRoot = relative(root, physical)
  return { path: physical, sourcePath: !isAbsolute(withinRoot) && withinRoot !== '..' && !withinRoot.startsWith('..\\') && !withinRoot.startsWith('../') ? withinRoot.replaceAll('\\', '/') : null,
    bytes, sha256: hash.digest('hex') }
}

export function moduleFileNames(module) {
  const visited = new Set(), files = new Set()
  const visit = value => {
    if (!value || visited.has(value)) return
    visited.add(value)
    if (value.filename && isAbsolute(value.filename)) files.add(value.filename)
    for (const child of value.children || []) visit(child)
  }
  visit(module)
  return [...files].sort()
}

export async function externalEvidence(require, root) {
  const entry = require.resolve('better-sqlite3')
  const module = require.cache[entry]
  if (!module) throw new Error('SQLite external was not actually loaded')
  const files = await Promise.all(moduleFileNames(module).map(file => fileEvidence(file, root)))
  if (!files.some(file => file.path.endsWith('.node'))) throw new Error('SQLite external closure did not include the loaded native binding')
  return { entry, files, fingerprint: digest(JSON.stringify(files)), method: 'Recursive children of the actual loaded better-sqlite3 CommonJS module after database initialization; builtin Node modules have no disk entry.' }
}

export async function buildInputEvidence(metafile, virtualInputs, root) {
  const files = [], virtual = []
  for (const input of Object.keys(metafile.inputs).sort()) {
    if (virtualInputs.has(input)) {
      const contents = virtualInputs.get(input)
      virtual.push({ input, bytes: Buffer.byteLength(contents), contents, sha256: digest(contents) })
    } else {
      if (input.startsWith('benchmark-') || input.startsWith('<')) throw new Error(`Missing virtual build input evidence: ${input}`)
      files.push({ input, ...await fileEvidence(resolve(root, input), root) })
    }
  }
  return { files, virtual, fingerprint: digest(JSON.stringify({ files, virtual })), metafile }
}

export async function toolchainEvidence(require, root) {
  const esbuildApi = require.resolve('esbuild')
  const esbuildPackage = require.resolve('esbuild/package.json')
  const platformPackage = `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
  const binary = process.env.ESBUILD_BINARY_PATH && process.env.ESBUILD_BINARY_PATH !== '/usr/bin/esbuild'
    ? resolve(process.env.ESBUILD_BINARY_PATH) : require.resolve(platformPackage)
  if (!existsSync(binary)) throw new Error('Actual esbuild binary is missing')
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  if (result.error || result.status !== 0) throw new Error('Cannot identify the esbuild binary')
  return { electron: await fileEvidence(process.execPath, root), esbuildApi: await fileEvidence(esbuildApi, root), esbuildPackage: await fileEvidence(esbuildPackage, root),
    esbuildBinary: { ...await fileEvidence(binary, root), reportedVersion: result.stdout.trim() }, electronVersion: process.versions.electron, nodeVersion: process.versions.node, moduleAbi: process.versions.modules }
}

export async function verifyFilesUnchanged(entries, root) {
  const after = await Promise.all(entries.map(entry => fileEvidence(entry.path, root)))
  const changed = entries.filter((entry, index) => entry.sha256 !== after[index].sha256).map(entry => entry.path)
  if (changed.length) throw new Error(`Benchmark inputs changed while running: ${changed.join(', ')}`)
  return { verified: true, fileCount: entries.length }
}

export function staticCheck() {
  assert.deepEqual(parseArguments([]), { controlled: false, check: false })
  assert.equal(parseArguments(['--controlled']).controlled, true)
  for (const invalid of [['--unknown'], ['--output'], ['--controlled', '--controlled'], ['--output', 'a', '--output', 'b'], ['--check', '--controlled']]) assert.throws(() => parseArguments(invalid))
  const old = plannedRuns(false), controlled = plannedRuns(true)
  assert.equal(old.length, 10)
  assert.equal(controlled.length, 64)
  assert.equal(new Set(controlled.map(row => row.id)).size, 64)
  for (const scenario of scenarios) {
    assert.equal(controlled.filter(row => row.phase === 'warmup' && row.scenario === scenario).length, 2)
    assert.equal(controlled.filter(row => row.phase === 'measured' && row.scenario === scenario).length, 30)
  }
  assert.equal(controlled.filter(row => row.phase === 'measured' && row.round % 2 && row.scenario === scenarios[0]).length, 15)
  assert.notEqual(createFixture(false).version, createFixture(true).version)
  const first = { filename: resolve('one.js'), children: [] }, second = { filename: resolve('two.node'), children: [first] }
  first.children.push(second, second)
  assert.deepEqual(moduleFileNames(first), [first.filename, second.filename].sort())
  assert.equal(digest('input'), digest(Buffer.from('input')))
  console.log(JSON.stringify({ staticCheck: 'passed', applicationLaunched: false, benchmarkExecuted: false,
    defaultRuns: old.length, controlledRuns: controlled.length, fixture: createFixture(true), protocol: controlled,
    limits: ['One process only; observations are not independent process replications.', 'This creates a new controlled baseline and cannot resolve or overwrite the historical 20.33ms to 26.94ms review.'] }, null, 2))
}
