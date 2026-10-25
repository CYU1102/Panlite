/** Background-only deterministic local workload. No application profile, account,
 * remote service or model is opened. Run under either Node or Electron's Node mode:
 * node scripts/benchmark-workflows.mjs --output output/workflows.json [--baseline earlier.json]
 */
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import reportTools from './benchmark-report.cjs'

const { round, statistics, metadata, readBaseline, compareReports } = reportTools
const root = resolve(import.meta.dirname, '..')
const argument = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a file path`)
  return resolve(value)
}
const output = argument('--output') ?? resolve(root, 'dist/reports/workflow-benchmark.json')
const baselinePath = argument('--baseline')
if (baselinePath === output) throw new Error('Use a separate output file to preserve the previous candidate report')
const baseline = readBaseline(baselinePath)
const fixture = {
  version: 'workflows-fixed-v1', runs: 5,
  directory: { entries: 100_000, pageSize: 500, id: 'file-${index}', metadata: 'fixed-total' },
  retrieval: { chunks: 20_000, documents: 200, padding: '常规归档信息。'.repeat(120), id: 'chunk-${index}', target: 19_999, identifier: 'AUDIT-TAIL-7319', semanticVector: [0, 1], ordinaryVector: [1, 0], limit: 8, scenarios: ['lexical-tail', 'semantic-tail', 'summary-endpoints', 'absent-evidence'] },
  cancellation: { totalBytes: 64 * 1024 * 1024, connections: 4, responseBlockBytes: 32 * 1024, intervalMs: 5, abortAfterFirstProgress: true, previousTarget: 'existing-file-must-survive' },
}
const provenance = metadata(root, fixture, [
  'scripts/benchmark-report.cjs', 'scripts/benchmark-workflows.mjs',
  'src/adapters/shared-directory.ts', 'src/main/ai/document-index.ts', 'src/main/chunked-download.ts',
])
const scratch = mkdtempSync(join(tmpdir(), 'panlite-workflow-benchmark-'))
if (dirname(scratch) !== tmpdir() || !scratch.startsWith(join(tmpdir(), 'panlite-workflow-benchmark-'))) throw new Error('Refusing cleanup outside the benchmark temporary directory')
const heapSamples = []
const sampleMemory = label => heapSamples.push({ label, ...process.memoryUsage() })
let server

try {
  const compiled = join(scratch, 'workloads.mjs')
  await build({
    stdin: { contents: "export { SharedDirectoryPages } from './src/adapters/shared-directory.ts'; export { rankDocumentChunkSource } from './src/main/ai/document-index.ts'; export { chunkedDownloadTo } from './src/main/chunked-download.ts'", resolveDir: root, loader: 'ts' },
    outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'loopback-node-transport', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'benchmark' }))
      builder.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: 'export const net = { fetch: globalThis.fetch }' }))
    } }],
  })
  const { SharedDirectoryPages, rankDocumentChunkSource, chunkedDownloadTo } = await import(pathToFileURL(compiled).href)
  sampleMemory('compiled-before-workloads')

  const directorySamples = []
  for (let run = 0; run < fixture.runs; run++) {
    const pages = new SharedDirectoryPages('固定大目录')
    const started = performance.now()
    let accepted = 0, hasMore = true
    for (let start = 0; start < fixture.directory.entries; start += fixture.directory.pageSize) {
      const ids = Array.from({ length: fixture.directory.pageSize }, (_, offset) => `file-${start + offset}`)
      hasMore = pages.accept(ids, fixture.directory.pageSize, { _total: fixture.directory.entries, _size: fixture.directory.pageSize })
      accepted += ids.length
      if (hasMore !== (accepted < fixture.directory.entries)) throw new Error(`Directory incorrectly stopped at ${accepted}`)
    }
    if (accepted !== fixture.directory.entries || hasMore) throw new Error('Directory coverage mismatch')
    directorySamples.push(performance.now() - started)
    sampleMemory(`directory-${run + 1}`)
    await new Promise(done => setImmediate(done))
  }

  // Generate one row at a time as the production SQLite iterator does. Reusing
  // source() opens a complete fresh pass; nothing materializes the entire corpus.
  const retrievalSamples = Object.fromEntries(fixture.retrieval.scenarios.map(name => [name, []]))
  const retrievalEvidence = []
  const scenarios = [
    { name: 'lexical-tail', query: 'AUDIT-TAIL-7319', embedding: null, passes: 2, check: rows => rows[0]?.id === 'chunk-19999' },
    { name: 'semantic-tail', query: '相关证据', embedding: [0, 1], passes: 3, check: rows => rows[0]?.id === 'chunk-19999' },
    { name: 'summary-endpoints', query: '总结', embedding: null, passes: 2, check: rows => rows.length === 8 && rows[0]?.id === 'chunk-0' && rows[7]?.id === 'chunk-19999' },
    { name: 'absent-evidence', query: 'NONEXISTENT-9527', embedding: null, passes: 1, check: rows => rows.length === 0 },
  ]
  for (const scenario of scenarios) {
    for (let run = 0; run < fixture.runs; run++) {
      const visits = []
      const source = function* () {
        const pass = visits.length
        visits.push(0)
        for (let index = 0; index < fixture.retrieval.chunks; index++) {
          visits[pass]++
          yield {
            id: `chunk-${index}`, chunkIndex: index % 100,
            documentId: `document-${Math.floor(index / 100)}`, documentName: `归档${Math.floor(index / 100)}.txt`,
            content: `${fixture.retrieval.padding}${index === fixture.retrieval.target ? ' AUDIT-TAIL-7319 已核验尾部证据。' : '常规内容。'}`,
            ...(scenario.embedding ? { embedding: index === fixture.retrieval.target ? [0, 1] : [1, 0] } : {}),
          }
        }
      }
      const started = performance.now()
      const rows = rankDocumentChunkSource(source, scenario.query, scenario.embedding, fixture.retrieval.limit)
      const elapsed = performance.now() - started
      if (!scenario.check(rows)) throw new Error(`Retrieval correctness failed: ${scenario.name}`)
      if (visits.length !== scenario.passes || visits.some(count => count !== fixture.retrieval.chunks)) throw new Error(`Incomplete retrieval scan: ${scenario.name}: ${JSON.stringify(visits)}`)
      retrievalSamples[scenario.name].push(elapsed)
      retrievalEvidence.push({ scenario: scenario.name, run: run + 1, passes: visits, resultIds: rows.map(row => row.id), elapsedMs: round(elapsed) })
      sampleMemory(`retrieval-${scenario.name}-${run + 1}`)
      await new Promise(done => setImmediate(done))
    }
  }

  let activeResponses = 0
  server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (!range) { response.writeHead(400).end(); return }
    const start = Number(range[1]), end = Number(range[2])
    let remaining = end - start + 1
    activeResponses++
    response.writeHead(206, { 'Content-Length': remaining, 'Content-Range': `bytes ${start}-${end}/${fixture.cancellation.totalBytes}` })
    const timer = setInterval(() => {
      if (remaining <= 0) { response.end(); return }
      const length = Math.min(remaining, fixture.cancellation.responseBlockBytes)
      response.write(Buffer.alloc(length, 0x5a))
      remaining -= length
    }, fixture.cancellation.intervalMs)
    response.once('close', () => { clearInterval(timer); activeResponses-- })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const cancellationSamples = []
  for (let run = 0; run < fixture.runs; run++) {
    const target = join(scratch, `cancel-target-${run}.bin`)
    writeFileSync(target, fixture.cancellation.previousTarget)
    const controller = new AbortController()
    let abortedAt, rejection
    const deadline = setTimeout(() => controller.abort(new Error('Benchmark first-byte deadline exceeded')), 10_000)
    try {
      await chunkedDownloadTo({ url: `http://127.0.0.1:${server.address().port}/fixed-range`, targetPath: target, totalSize: fixture.cancellation.totalBytes, connections: fixture.cancellation.connections, signal: controller.signal,
        onProgress: () => { if (abortedAt === undefined) { abortedAt = performance.now(); controller.abort(new Error('Synthetic user cancellation')) } },
      })
    } catch (error) { rejection = String(error) }
    finally { clearTimeout(deadline) }
    if (abortedAt === undefined || !rejection) throw new Error('Cancellation did not reject after real response progress')
    const cancelledMs = performance.now() - abortedAt
    if (readFileSync(target, 'utf8') !== fixture.cancellation.previousTarget) throw new Error('Cancellation replaced the previous file')
    if (readdirSync(scratch).some(name => name.startsWith('.panlite-download-'))) throw new Error('Cancellation left temporary parts')
    const closeDeadline = performance.now() + 2000
    while (activeResponses && performance.now() < closeDeadline) await new Promise(done => setTimeout(done, 5))
    if (activeResponses) throw new Error('Cancelled transfer left active HTTP responses')
    cancellationSamples.push({ run: run + 1, settleAndCleanupMs: round(cancelledMs), responseClosureMs: round(performance.now() - abortedAt), previousTargetPreserved: true, temporaryPartsRemoved: true, activeResponses })
    sampleMemory(`cancellation-${run + 1}`)
  }

  const report = {
    schema: 1, benchmark: 'local-workflows', recordedAt: new Date().toISOString(), ...provenance,
    directory: { ...statistics(directorySamples), allEntriesAccepted: fixture.directory.entries, pagesPerRun: fixture.directory.entries / fixture.directory.pageSize, samplesMs: directorySamples.map(round) },
    retrieval: { scenarios: Object.fromEntries(Object.entries(retrievalSamples).map(([name, samples]) => [name, statistics(samples)])), evidence: retrievalEvidence, tailDocument: 'document-199', completePassesVerified: true, externalModelRequests: 0 },
    cancellation: { ...statistics(cancellationSamples.map(sample => sample.settleAndCleanupMs)), samples: cancellationSamples, transport: 'Node fetch over loopback using production chunkedDownloadTo; not remote-provider or whole-task cancellation latency' },
    memory: { sampledPeakRssBytes: Math.max(...heapSamples.map(sample => sample.rss)), sampledPeakHeapUsedBytes: Math.max(...heapSamples.map(sample => sample.heapUsed)), processPeakRssBytes: process.resourceUsage().maxRSS * 1024, samples: heapSamples, method: 'Stage-boundary process.memoryUsage samples; OS maxRSS includes fixture compilation. This is process memory, not an asserted per-workload peak or a leak proof.' },
    limits: ['Generator-based retrieval uses the production full-scope ranker, with SQLite/IPC/parse/network latency excluded. Catalog persistence is measured separately by benchmark-catalog.mjs.', 'Directory measurement covers real pagination validation and identifier retention, not remote listing latency or renderer table performance.', 'Five warm-process samples per scenario; OS cache and other processes are uncontrolled. No acceleration claim is made without a compatible earlier candidate.', 'No application profile, credentials, visible windows, production account writes or external model calls.'],
  }
  report.comparison = compareReports(report, baseline, ['directory.p95Ms', 'retrieval.scenarios.lexical-tail.p95Ms', 'retrieval.scenarios.semantic-tail.p95Ms', 'cancellation.p95Ms', 'memory.sampledPeakRssBytes'])
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, fixtureSha256: report.fixtureSha256, directory: report.directory, retrieval: report.retrieval.scenarios, cancellation: { p95Ms: report.cancellation.p95Ms }, memory: { sampledPeakRssBytes: report.memory.sampledPeakRssBytes }, comparison: report.comparison }, null, 2))
} finally {
  if (server) {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
