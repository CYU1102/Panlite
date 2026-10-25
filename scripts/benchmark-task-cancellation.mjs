/** Actual task admission, SQLite lifecycle and execution-token benchmark.
 * Only the provider adapter, Electron shell, credential encryption, archive and
 * notifications are substituted. HTTP stays on loopback; no GUI/profile/account.
 * node scripts/benchmark-task-cancellation.mjs [--output report.json] [--baseline earlier.json]
 * The launcher selects Electron's Node mode without rebuilding SQLite.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import reportTools from './benchmark-report.cjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const { metadata, statistics, round, readBaseline, compareReports } = reportTools
const argument = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a file path`)
  return resolve(value)
}

if (!process.versions.electron) {
  const child = spawn(require('electron'), [resolve(import.meta.filename), ...process.argv.slice(2)], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit' })
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
} else {
  // initDatabase owns an hourly timer. Exit only after the benchmark's awaited
  // queue, HTTP, database and owned-directory cleanup have all completed.
  try { await runBenchmark(); process.exit(0) }
  catch (error) { console.error(error); process.exit(1) }
}

async function runBenchmark() {
  const output = argument('--output') ?? resolve(root, 'dist/reports/task-cancellation-benchmark.json')
  const baselinePath = argument('--baseline')
  if (output === baselinePath) throw new Error('Use a separate output file to preserve the previous candidate report')
  const baseline = readBaseline(baselinePath)
  const fixture = { version: 'task-cancellation-fixed-v1', runsPerScenario: 5, scenarios: ['cooperative-abort', 'late-success-after-abort'], fileBytes: 1024 * 1024, firstResponseBytes: 1024, lateCompletionDelayMs: 25, idlePollMs: 1, finalStabilityWaitMs: 30, account: 'synthetic-quark', taskType: 'download', conflictPolicy: 'overwrite', originalTarget: 'valuable-original-bytes' }
  const provenance = metadata(root, fixture, [
    'scripts/benchmark-task-cancellation.mjs', 'scripts/benchmark-report.cjs', 'src/main/task-runner.ts', 'src/main/task-admission.ts',
    'src/main/db.ts', 'src/main/task-state-machine.ts', 'src/main/task-operations.ts', 'src/main/account-request-budget.ts', 'src/main/download-target.ts',
  ])
  const scratch = mkdtempSync(join(tmpdir(), 'panlite-task-cancellation-bench-'))
  if (dirname(scratch) !== tmpdir() || !basename(scratch).startsWith('panlite-task-cancellation-bench-')) throw new Error('Unsafe benchmark cleanup path')
  let database, server, activeRun
  const samples = [], memorySamples = [], allTaskIds = []
  const memory = label => memorySamples.push({ label, ...process.memoryUsage() })
  const wait = ms => new Promise(done => setTimeout(done, ms))
  const waitFor = async (predicate, label, timeout = 10_000) => {
    const deadline = performance.now() + timeout
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`)
      await wait(fixture.idlePollMs)
    }
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message) }

  try {
    const compiled = join(scratch, 'queue.cjs')
    await build({
      stdin: { contents: "export { initDatabase, getDb, insertAccount, insertTask, getTaskById, updateTaskProgressIfOwned, updateTaskPayloadIfOwned, transitionTaskStatusIfCurrent } from './src/main/db.ts'; export { enqueueTask, cancelTask, getQueueStatus } from './src/main/task-runner.ts'", resolveDir: root, loader: 'ts' },
      outfile: compiled, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
      plugins: [{ name: 'synthetic-task-shell-and-provider', setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true }))
        builder.onResolve({ filter: /^(electron|electron-log)$/ }, args => ({ path: args.path, namespace: 'benchmark-shell' }))
        builder.onLoad({ filter: /.*/, namespace: 'benchmark-shell' }, args => ({ contents: args.path === 'electron'
          ? `export const app = { getPath: () => ${JSON.stringify(scratch)} }; export const BrowserWindow = { getAllWindows: () => [] }; export const net = { fetch: globalThis.fetch }`
          : 'export default { info() {}, warn() {}, error() {} }' }))
        builder.onResolve({ filter: /adapters\/registry$/ }, () => ({ path: 'registry', namespace: 'benchmark-dependency' }))
        builder.onResolve({ filter: /^\.\/(crypto|archive|runtime-services)$/ }, args => ({ path: args.path.slice(2), namespace: 'benchmark-dependency' }))
        builder.onLoad({ filter: /.*/, namespace: 'benchmark-dependency' }, args => ({ contents: {
          registry: "export const getAdapter = platform => { if (platform !== 'quark') throw new Error('Unexpected benchmark platform'); return globalThis.__PANLITE_TASK_BENCHMARK_ADAPTER }",
          crypto: 'export const decryptCredential = value => value',
          archive: "export const cleanupTempDir = () => {}; export const createArchive = () => { throw new Error('Archive not part of fixture') }; export const extractArchive = createArchive",
          'runtime-services': 'export const notifyTaskTerminal = () => {}',
        }[args.path] }))
      } }],
    })

    server = createServer((request, response) => {
      const run = activeRun
      if (!run || request.url !== `/${run.id}`) { response.writeHead(404).end(); return }
      run.httpRequestStartedAt = performance.now()
      response.once('close', () => { run.httpClosedAt = performance.now() })
      response.writeHead(200, { 'Content-Length': fixture.fileBytes })
      response.write(Buffer.alloc(fixture.firstResponseBytes, 0x5a))
      // Deliberately withhold the rest. Cancellation must terminate a genuine
      // pending body read rather than an already-resolved synthetic promise.
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    globalThis.__PANLITE_TASK_BENCHMARK_ADAPTER = {
      listFiles: async (_account, parentId) => ({ files: [], parentId, hasMore: false }),
      download: async (_account, fileId, directory, options) => {
        const run = activeRun
        assert(fileId === run.id && options?.signal instanceof AbortSignal, 'Task did not pass its execution AbortSignal to the adapter')
        run.adapterEnteredAt = performance.now()
        run.signal = options.signal
        const aborted = () => { run.adapterAbortAt = performance.now(); memory(`${run.id}-adapter-abort`) }
        options.signal.addEventListener('abort', aborted, { once: true })
        try {
          const response = await fetch(`http://127.0.0.1:${server.address().port}/${run.id}`, { signal: options.signal })
          assert(response.status === 200 && response.body, 'Synthetic loopback response missing')
          const reader = response.body.getReader()
          let loaded = 0
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error('Synthetic response unexpectedly completed before cancellation')
            loaded += chunk.value.length
            options.onProgress({ loaded, percent: loaded / fixture.fileBytes * 100, speed: 0 })
            run.progressObservedAt = performance.now()
          }
        } catch (error) {
          run.fetchRejectedAt = performance.now()
          if (!options.signal.aborted) throw error
          if (run.scenario === 'cooperative-abort') throw error
          await wait(fixture.lateCompletionDelayMs)
          // A misbehaving provider can report progress/success after abort.
          // The real runner must fence both and remove the owned staging file.
          options.onProgress({ loaded: fixture.fileBytes, percent: 100, speed: 0 })
          run.lateProgressAt = performance.now()
          const localPath = join(directory, options.fileName)
          writeFileSync(localPath, Buffer.alloc(fixture.fileBytes, 0x5a))
          run.lateResultAt = performance.now()
          return { success: true, localPath }
        } finally {
          options.signal.removeEventListener('abort', aborted)
          run.adapterSettledAt = performance.now()
        }
      },
    }
    const queue = require(compiled)
    queue.initDatabase()
    database = queue.getDb()
    queue.insertAccount({ id: 'synthetic-quark', platform: 'quark', nickname: 'Isolated benchmark only', login_type: 'cookie', encrypted_credential: '{}', user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
    const idle = () => Object.values(queue.getQueueStatus()).every(status => !status.pending && !status.running && !status.size)
    memory('before-task-runs')
    for (const scenario of fixture.scenarios) {
      for (let index = 0; index < fixture.runsPerScenario; index++) {
        const id = `${scenario}-${index + 1}`
        allTaskIds.push(id)
        const downloadDirectory = join(scratch, id)
        mkdirSync(downloadDirectory)
        const target = join(downloadDirectory, 'source.bin')
        writeFileSync(target, fixture.originalTarget)
        activeRun = { id, scenario }
        const run = activeRun
        queue.insertTask({ id, account_id: 'synthetic-quark', platform: 'quark', task_type: 'download', title: id, payload: JSON.stringify({ targetDirPath: downloadDirectory, conflictPolicy: 'overwrite', files: [{ fileId: id, fileName: 'source.bin', fileSize: fixture.fileBytes, isDir: false }] }), status: 'pending', progress: 0, retry_count: 3, execution_token: null, error_message: null, created_at: index + 1, updated_at: index + 1, finished_at: null })
        const enqueuedAt = performance.now()
        queue.enqueueTask(id)
        await waitFor(() => run.progressObservedAt !== undefined, `${id} adapter real first body read`)
        const running = queue.getTaskById(id)
        assert(running?.status === 'running' && typeof running.execution_token === 'string' && running.execution_token.length > 0, 'Real SQLite task was not claimed with an execution token')
        assert(queue.getQueueStatus().quark?.running === 1, 'Real admission queue has no running worker')
        const token = running.execution_token
        run.cancelRequestedAt = performance.now()
        assert(queue.cancelTask(id), 'User cancellation was rejected')
        run.cancelReturnedAt = performance.now()
        const cancelled = queue.getTaskById(id)
        assert(cancelled.status === 'cancelled' && cancelled.execution_token === null, 'Cancellation did not atomically fence SQLite ownership')
        assert(run.signal.aborted && run.adapterAbortAt !== undefined, 'Cancellation did not abort the adapter')
        await waitFor(idle, `${id} actual task queue idle`)
        run.queueIdleAt = performance.now()
        await waitFor(() => run.httpClosedAt !== undefined, `${id} loopback response closed`)
        assert(run.adapterSettledAt !== undefined, 'Queue reported idle before the adapter settled')
        assert(!queue.updateTaskProgressIfOwned(id, token, 100), 'Stale worker changed task progress')
        assert(!queue.updateTaskPayloadIfOwned(id, token, { results: [{ status: 'success' }] }), 'Stale worker changed task payload')
        assert(!queue.transitionTaskStatusIfCurrent(id, 'running', 'success', { expectedExecutionToken: token, executionToken: token }), 'Stale worker resurrected cancelled task')
        const beforeStabilityWait = queue.getTaskById(id)
        await wait(fixture.finalStabilityWaitMs)
        const final = queue.getTaskById(id)
        assert(JSON.stringify(final) === JSON.stringify(beforeStabilityWait), 'Cancelled task changed after queue idle and stale callbacks')
        assert(final.status === 'cancelled' && final.execution_token === null && final.progress < 100 && final.retry_count === 3, 'Cancelled task terminal state was overwritten or retried')
        assert(readFileSync(target, 'utf8') === fixture.originalTarget, 'Cancelled task replaced an existing file')
        assert(readdirSync(downloadDirectory).length === 1, 'Task staging cleanup left files/directories behind')
        if (scenario === 'late-success-after-abort') assert(run.lateProgressAt > run.cancelRequestedAt && run.lateResultAt > run.cancelRequestedAt, 'Late provider callback/result was not actually exercised')
        memory(`${id}-final-stable`)
        samples.push({
          id, scenario, enqueueToAdapterMs: round(run.adapterEnteredAt - enqueuedAt), cancelCallMs: round(run.cancelReturnedAt - run.cancelRequestedAt),
          cancelToAdapterAbortMs: round(run.adapterAbortAt - run.cancelRequestedAt), cancelToFetchRejectedMs: round(run.fetchRejectedAt - run.cancelRequestedAt),
          cancelToQueueIdleMs: round(run.queueIdleAt - run.cancelRequestedAt), cancelToHttpClosedMs: round(run.httpClosedAt - run.cancelRequestedAt),
          lateProviderResultObserved: scenario === 'late-success-after-abort', staleProgressRejected: true, stalePayloadRejected: true, staleCompletionRejected: true,
          finalStatus: final.status, executionTokenCleared: final.execution_token === null, originalTargetPreserved: true, stagingRemoved: true, queueIdle: idle(),
        })
      }
    }
    const report = {
      schema: 1, benchmark: 'actual-task-queue-cancellation', recordedAt: new Date().toISOString(), ...provenance,
      environment: { ...provenance.environment, sqlite: database.prepare('SELECT sqlite_version() AS version').get().version },
      scenarios: Object.fromEntries(fixture.scenarios.map(scenario => {
        const rows = samples.filter(sample => sample.scenario === scenario)
        return [scenario, { adapterAbort: statistics(rows.map(row => row.cancelToAdapterAbortMs)), queueIdle: statistics(rows.map(row => row.cancelToQueueIdleMs)), httpClosed: statistics(rows.map(row => row.cancelToHttpClosedMs)) }]
      })),
      samples, memory: { sampledPeakRssBytes: Math.max(...memorySamples.map(sample => sample.rss)), sampledPeakHeapUsedBytes: Math.max(...memorySamples.map(sample => sample.heapUsed)), processPeakRssBytes: process.resourceUsage().maxRSS * 1024, samples: memorySamples, method: 'Stage-boundary process samples; OS maximum includes compilation/database initialization. No assertion about a per-task peak or absence of leaks.' },
      verified: { realTaskRunner: true, realAdmissionQueue: true, realSqliteStateAndTokens: true, realAbortableLoopbackBodyRead: true, allTasksCancelled: allTaskIds.every(id => queue.getTaskById(id).status === 'cancelled'), lateResultsFenced: true, queueIdleAtEnd: idle(), originalFilesPreserved: true },
      limits: ['Synthetic provider adapter over loopback; not end-to-end cloud-provider cancellation or renderer IPC latency.', 'Late-success scenario intentionally adds a fixed 25ms delay after abort to prove stale callbacks/results are fenced; that delay is included in queue-idle timing.', 'The actual download task uses atomic fallback staging, not the resumable path. Other task types and provider-owned asynchronous jobs need separate workloads.', 'Five samples per scenario, warm process, OS cache and competing load uncontrolled. No speedup claim without a compatible previous candidate.'],
    }
    report.comparison = compareReports(report, baseline, ['scenarios.cooperative-abort.adapterAbort.p95Ms', 'scenarios.cooperative-abort.queueIdle.p95Ms', 'scenarios.late-success-after-abort.queueIdle.p95Ms', 'memory.sampledPeakRssBytes'])
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ output, scenarios: report.scenarios, verified: report.verified, memory: { sampledPeakRssBytes: report.memory.sampledPeakRssBytes }, comparison: report.comparison }, null, 2))
  } finally {
    if (activeRun?.signal && !activeRun.signal.aborted) server?.closeAllConnections()
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
    database?.close()
    delete globalThis.__PANLITE_TASK_BENCHMARK_ADAPTER
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
