/** Reproducible catalog benchmark. Run with a Node-compatible better-sqlite3 build:
 * node scripts/benchmark-catalog.mjs [--output path/to/report.json]
 * Creates and removes its own OS temporary directory; never opens application data or real accounts.
 */
import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, cpus, platform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = mkdtempSync(join(tmpdir(), 'panlite-catalog-benchmark-'))
const outputAt = process.argv.indexOf('--output')
const output = outputAt >= 0 ? process.argv[outputAt + 1] : undefined
if (outputAt >= 0 && !output) throw new Error('--output needs a file path')
let db, service
try {
  const compiled = join(temporary, 'catalog.mjs')
  await build({
    stdin: { contents: "export * from './src/main/catalog-store.ts'; export * from './src/main/catalog-service.ts'", resolveDir: project, loader: 'ts' },
    outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  })
  const { CatalogStore, CatalogService, initializeCatalogSchema } = await import(pathToFileURL(compiled).href)
  db = new Database(join(temporary, 'catalog.sqlite'))
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); initializeCatalogSchema(db)
  const store = new CatalogStore(db)
  const zh = ['项目', '报告', '照片', '合同', '发票', '数据', '资料', '备份', '计划', '文档', '学习', '音乐', '旅行', '设计', '研发', '财务', '产品', '测试', '归档', '家庭']
  const en = ['budget', 'roadmap', 'invoice', 'holiday', 'meeting', 'design', 'release', 'product', 'archive', 'research', 'family', 'training', 'report', 'project', 'backup', 'dataset', 'contract', 'finance', 'sample', 'planning']
  const extensions = ['pdf', 'jpg', 'mp4', 'txt', 'zip']
  const accounts = new Map(Array.from({ length: 10 }, (_, index) => [`account-${index}`, { id: `account-${index}`, nickname: `测试账号${index}`, platform: 'webdav', status: 'active' }]))
  const rowsPerAccount = 10_000, epoch = Date.UTC(2024, 0, 1)
  service = new CatalogService(store, {
    getAccount: id => accounts.get(id),
    listFiles: async accountId => {
      const accountIndex = Number(accountId.split('-')[1])
      return { parentId: 'root', hasMore: false, files: Array.from({ length: rowsPerAccount }, (_, localIndex) => {
        const index = accountIndex * rowsPerAccount + localIndex
        return {
          id: `file-${localIndex}`, parentId: 'root', name: `${zh[index % 20]}_${en[Math.floor(index / 20) % 20]}_${index}.${extensions[Math.floor(index / 400) % 5]}`,
          accountId, platform: 'webdav', isDir: false, size: (index % 10_000 + 1) * 1024,
          createdAt: epoch, updatedAt: epoch + (index % 730) * 86_400_000,
        }
      }) }
    },
  })
  const timings = Object.fromEntries(['writeBatch', 'finishDirectory', 'finishReadyScans', 'search'].map(name => [name, []]))
  for (const name of Object.keys(timings)) {
    const original = store[name].bind(store)
    store[name] = (...args) => { const start = performance.now(); try { return original(...args) } finally { timings[name].push(performance.now() - start) } }
  }
  const requireSuccess = result => { if (!result.success) throw new Error(result.error); return result }
  const ingestStart = performance.now()
  for (const account of accounts.values()) {
    const scope = requireSuccess(await service.addScope({ accountId: account.id, rootId: 'root', rootPath: `/归档/${account.nickname}` })).scope
    requireSuccess(await service.startScan(scope.id))
  }
  await service.waitForIdle()
  const ingestMs = performance.now() - ingestStart
  const total = requireSuccess(await service.search({ pageSize: 1 })).total
  if (total !== 100_000 || store.listScopes().some(scope => scope.status !== 'completed')) throw new Error(`Unexpected corpus coverage: ${total}`)
  const collection = requireSuccess(await service.saveCollection({ name: '基准集合' })).collection
  for (let index = 0; index < 1000; index++) {
    const identity = { accountId: `account-${index % 10}`, fileId: `file-${index}` }
    store.setTags(identity, [index % 2 ? '工作' : '家庭', '基准'])
    store.setFavorite(identity, index % 3 === 0)
    store.setEntryCollections(identity, [collection.id])
  }
  const queries = [
    ...zh.map(word => ({ group: 'chinese_1_character', query: { keyword: word[0] } })),
    ...zh.map(word => ({ group: 'chinese_2_characters', query: { keyword: word } })),
    ...en.map(word => ({ group: 'english', query: { keyword: word } })),
    ...zh.map((word, index) => ({ group: 'combined', query: {
      keyword: word, path: '/归档/', accountIds: [`account-${index % 10}`], minSize: 1024, maxSize: 8_000_000,
      dateFrom: epoch, dateTo: epoch + 500 * 86_400_000, fileTypes: index % 2 ? ['document'] : ['image', 'archive'],
      ...(index % 4 === 0 ? { tags: ['基准'], collectionId: collection.id } : {}),
      ...(index % 5 === 0 ? { favorite: true } : {}),
    } })),
    ...en.map((word, index) => ({ group: 'paged_sorted', query: { keyword: word, page: index + 1, pageSize: 100, sortBy: index % 2 ? 'size' : 'updatedAt', sortOrder: 'desc' } })),
  ]
  for (const index of [0, 20, 40, 60, 80]) requireSuccess(await service.search(queries[index].query))
  timings.search.length = 0
  const results = []
  for (const item of queries) {
    await new Promise(done => setImmediate(done))
    const start = performance.now(), result = requireSuccess(await service.search(item.query))
    results.push({ ...item, elapsedMs: performance.now() - start, total: result.total, returned: result.entries.length })
  }
  const round = value => Math.round(value * 100) / 100
  const stats = values => {
    const sorted = [...values].sort((a, b) => a - b)
    return { count: sorted.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1] ?? 0), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1] ?? 0), maxMs: round(sorted.at(-1) ?? 0) }
  }
  const report = {
    schema: 1, fixture: 'catalog-fixed-v1', recordedAt: new Date().toISOString(),
    environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: round(totalmem() / 1024 ** 3), node: process.version, sqlite: db.prepare('SELECT sqlite_version() version').get().version },
    corpus: { entries: total, accounts: accounts.size, directories: accounts.size, queryCount: queries.length, seed: 'deterministic index arithmetic, no random generator', localMetadataOnly: true },
    ingestion: { elapsedMs: round(ingestMs), synchronousOperations: Object.fromEntries(Object.entries(timings).filter(([name]) => name !== 'search').map(([name, values]) => [name, stats(values)])) },
    queries: { overall: stats(results.map(row => row.elapsedMs)), groups: Object.fromEntries([...new Set(results.map(row => row.group))].map(group => [group, stats(results.filter(row => row.group === group).map(row => row.elapsedMs))])), p95TargetMs: 500 },
    samples: results.map(row => ({ ...row, elapsedMs: round(row.elapsedMs) })),
    notes: ['Measures in-process local API response, including count, sort, pagination and annotation hydration; no remote I/O or credential access.', 'Literal substring matching preserves 1–2 character Chinese semantics. No FTS truncation or token expansion.', 'SQLite WAL temporary database and compiled modules are removed after the run. Five representative queries warm the connection; each of 100 fixed queries is measured once.', 'Synchronous operation timings expose main-thread blocking. Results apply to this recorded machine/run; they are not a guarantee for every account/provider.'],
  }
  if (output) { const target = resolve(output); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2))
} finally {
  service?.dispose()
  if (service) await service.waitForIdle()
  db?.close()
  rmSync(temporary, { recursive: true, force: true })
}
