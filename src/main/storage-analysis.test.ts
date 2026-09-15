import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CatalogResult } from '../shared/catalog'
import type { FileItem, FileListResult } from '../shared/types'
import type { StoragePlanInput } from '../shared/storage-analysis'
import { CatalogService } from './catalog-service'
import { CatalogStore, initializeCatalogSchema, type CatalogAccount } from './catalog-store'
import { initializeStorageAnalysisSchema, StorageAnalysisStore } from './storage-analysis-store'
import { serializeStoragePlan, StorageAnalysisService } from './storage-analysis-service'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function ok<T extends object>(result: CatalogResult<T>): T { if (!result.success) throw new Error(result.error); return result }
function file(id: string, parentId = 'root', options: Partial<FileItem> = {}): FileItem {
  return { id, parentId, name: '副本.txt', accountId: 'a', platform: 'pan123', isDir: false, size: 100, updatedAt: 2, createdAt: 1, ...options }
}
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initializeCatalogSchema(db)
  const accounts = new Map<string, CatalogAccount>([
    ['a', { id: 'a', nickname: '工作盘', platform: 'pan123', status: 'active' }],
    ['b', { id: 'b', nickname: '个人盘', platform: 'pan123', status: 'active' }],
  ])
  let now = 1000
  const catalogStore = new CatalogStore(db, () => now)
  const tree = new Map<string, FileListResult | Error>()
  const listFiles = vi.fn(async (accountId: string, parentId: string): Promise<FileListResult> => {
    const value = tree.get(`${accountId}:${parentId}`)
    if (value instanceof Error) throw value
    return value ?? { files: [], parentId, hasMore: false }
  })
  const catalog = new CatalogService(catalogStore, { getAccount: id => accounts.get(id), listFiles })
  initializeStorageAnalysisSchema(db)
  const store = new StorageAnalysisStore(db, () => now)
  const resolveEntry = vi.fn(catalog.resolveEntry)
  const readMetadata = vi.fn(async (entry: { accountId: string; parentId: string; fileId: string }) => {
    const listing = await listFiles(entry.accountId, entry.parentId)
    return listing.files.find(file => file.id === entry.fileId)!
  })
  const getQuota = vi.fn(async () => ({ used: 3000, total: 10000 }))
  const exportFile = vi.fn(async () => ({ cancelled: false, filePath: 'D:\\manifests\\review.csv' }))
  const service = new StorageAnalysisService(store, { getAccount: id => accounts.get(id), resolveEntry, readMetadata, getQuota, exportFile, now: () => now })
  cleanups.push(() => { catalog.dispose(); db.close() })
  return {
    db, accounts, tree, catalog, catalogStore, store, service, listFiles, resolveEntry, readMetadata, getQuota, exportFile,
    advance() { now++ },
    set(accountId: string, parentId: string, files: FileItem[]) { tree.set(`${accountId}:${parentId}`, { files, parentId, hasMore: false }) },
    async scope(accountId = 'a', rootId = 'root', rootPath = '/') { return ok(await catalog.addScope({ accountId, rootId, rootPath })).scope },
    async scan(id: string) { ok(await catalog.startScan(id)); await catalog.waitForIdle() },
  }
}
async function duplicates() {
  const f = fixture(), a = await f.scope(), b = await f.scope('b')
  f.set('a', 'root', [file('same', 'root', { raw: { etag: 'a'.repeat(32) } })])
  f.set('b', 'root', [file('same', 'root', { accountId: 'b', raw: { etag: 'A'.repeat(32) } })])
  await f.scan(a.id); await f.scan(b.id)
  return f
}
const references = [{ accountId: 'a', fileId: 'same' }, { accountId: 'b', fileId: 'same' }]
const planInput: StoragePlanInput = { group: { name: '副本.txt', size: 100 }, keep: references[0], remove: [references[1]] }

describe('indexed storage aggregation', () => {
  it('deduplicates overlapping scopes by account plus file ID and never adds folder sizes', async () => {
    const f = fixture(), root = await f.scope(), nested = await f.scope('a', 'dir', '/目录'), other = await f.scope('b')
    f.set('a', 'root', [file('dir', 'root', { name: '目录', isDir: true, size: 900000 }), file('large', 'root', { name: '大文件.zip', size: 500 })])
    f.set('a', 'dir', [file('same', 'dir')])
    f.set('b', 'root', [file('same', 'root', { accountId: 'b' })])
    await f.scan(root.id); await f.scan(nested.id); await f.scan(other.id)
    f.listFiles.mockClear()
    const summary = ok(await f.service.summary({})).summary
    expect(summary).toMatchObject({ bytes: 700, fileCount: 3, directoryCount: 1, coverage: { completeScopes: 3, totalScopes: 3 } })
    expect(summary.accounts.map(account => [account.accountId, account.bytes])).toEqual([['a', 600], ['b', 100]])
    expect(summary.types.reduce((sum, type) => sum + type.bytes, 0)).toBe(700)
    const onlyNested = ok(await f.service.summary({ scopeIds: [nested.id] })).summary
    expect(onlyNested).toMatchObject({ bytes: 100, fileCount: 1 })
    const dirs = ok(await f.service.listDirectories({})).items
    expect(dirs.find(dir => dir.accountId === 'a' && dir.fileId === 'dir')).toMatchObject({ bytes: 100, fileCount: 1, isScopeRoot: true })
    expect(dirs.find(dir => dir.accountId === 'a' && dir.fileId === 'root')).toMatchObject({ bytes: 600, fileCount: 2 })
    expect(dirs.find(dir => dir.accountId === 'b' && dir.fileId === 'root')).toMatchObject({ bytes: 100, fileCount: 1 })
    expect(ok(await f.service.summary({ fileTypes: ['archive'] })).summary.bytes).toBe(500)
    expect(ok(await f.service.listDirectories({ fileTypes: ['archive'] })).items.find(dir => dir.accountId === 'a' && dir.fileId === 'root')?.bytes).toBe(500)
    expect(f.listFiles).not.toHaveBeenCalled(); expect(f.getQuota).not.toHaveBeenCalled(); expect(f.exportFile).not.toHaveBeenCalled()
  })
  it('keeps failed scope coverage and timestamps visible with retained old entries', async () => {
    const f = fixture(), scope = await f.scope()
    f.set('a', 'root', [file('dir', 'root', { name: '失败目录', isDir: true })]); f.set('a', 'dir', [file('retained', 'dir')])
    await f.scan(scope.id); f.advance()
    f.tree.set('a:dir', new Error('signed-url=SECRET')); await f.scan(scope.id)
    const summary = ok(await f.service.summary({})).summary
    expect(summary).toMatchObject({ bytes: 100, coverage: { completeScopes: 0, failedDirectories: 1 } })
    expect(summary.scopes[0]).toMatchObject({ status: 'partial', lastCompletedAt: 1000, updatedAt: 1001 })
    expect(summary.scopes[0].failures[0].path).toBe('/失败目录')
    expect(JSON.stringify(summary)).not.toContain('SECRET')
  })
  it('upgrades an old catalog additively and preserves annotations across repeated initialization', async () => {
    const f = await duplicates()
    f.catalogStore.setTags(references[0], ['保留标签'])
    initializeStorageAnalysisSchema(f.db); initializeStorageAnalysisSchema(f.db)
    expect(f.store.member(references[0])?.tags).toEqual(['保留标签'])
    expect(ok(await f.service.listDuplicateGroups({})).total).toBe(1)
    f.catalogStore.removeAccount('b')
    expect(ok(await f.service.listDuplicateGroups({})).total).toBe(0)
  })
  it('pages grouped candidates, members, directories and large files with stable ordering', async () => {
    const f = fixture(), scope = await f.scope()
    f.set('a', 'root', Array.from({ length: 80 }, (_, i) => file(String(i), 'root', { name: `group-${Math.floor(i / 2)}.txt`, size: Math.floor(i / 2) + 1 })))
    await f.scan(scope.id)
    const first = ok(await f.service.listDuplicateGroups({ page: 1, pageSize: 10 }))
    const second = ok(await f.service.listDuplicateGroups({ page: 2, pageSize: 10 }))
    expect(first.total).toBe(40); expect(first.items).toHaveLength(10); expect(second.items).toHaveLength(10)
    expect(first.items[0].size).toBe(40); expect(second.items[0].size).toBe(30)
    const members = ok(await f.service.listGroupMembers({ group: first.items[0], page: 2, pageSize: 1 }))
    expect(members).toMatchObject({ total: 2, page: 2 }); expect(members.items).toHaveLength(1)
    expect(ok(await f.service.listLargeFiles({ page: 2, pageSize: 25 })).items).toHaveLength(25)
    expect(ok(await f.service.listDirectories({ page: 2, pageSize: 1 })).items).toEqual([])
  })
})

describe('evidence and review manifests', () => {
  it('keeps equal names and sizes as candidates until explicitly reading supported metadata', async () => {
    const f = await duplicates()
    expect(ok(await f.service.listDuplicateGroups({})).items[0]).toMatchObject({ status: 'candidate', evidenceCount: 0, possibleReleaseBytes: 100 })
    expect(ok(await f.service.createPlan(planInput)).plan).toMatchObject({ candidateReleaseBytes: 100, confirmedReleaseBytes: 0 })
    expect(f.readMetadata).not.toHaveBeenCalled()
    expect(ok(await f.service.verifyEvidence({ refs: references })).results.map(result => result.status)).toEqual(['verified', 'verified'])
    expect(f.resolveEntry).toHaveBeenCalledTimes(2)
    expect(ok(await f.service.listDuplicateGroups({ status: 'confirmed' })).items[0]).toMatchObject({ status: 'confirmed', evidenceCount: 2 })
    const plan = ok(await f.service.createPlan(planInput)).plan
    expect(plan).toMatchObject({ candidateReleaseBytes: 0, confirmedReleaseBytes: 100 })
    expect(plan.review[0].certainty).toBe('confirmed')
    const result = ok(await f.service.exportPlan({ ...planInput, format: 'json' }))
    expect(result.cancelled).toBe(false)
    expect(f.exportFile).toHaveBeenCalledWith(expect.stringContaining('"confirmedReleaseBytes": 100'), 'json')
  })
  it('does not treat same-name different-content files as duplicates or export them as removable copies', async () => {
    const f = await duplicates()
    f.set('b', 'root', [file('same', 'root', { accountId: 'b', raw: { etag: 'b'.repeat(32) } })])
    ok(await f.service.verifyEvidence({ refs: references }))
    expect(ok(await f.service.listDuplicateGroups({})).items[0]).toMatchObject({ status: 'different', possibleReleaseBytes: 0 })
    expect(await f.service.createPlan(planInput)).toMatchObject({ success: false, error: expect.stringContaining('哈希不同') })
    expect(await f.service.exportPlan({ ...planInput, format: 'csv' })).toMatchObject({ success: false })
    expect(f.exportFile).not.toHaveBeenCalled()
  })
  it('keeps unsupported ETags, missing hashes and different algorithms unconfirmed', async () => {
    const f = await duplicates()
    f.accounts.get('b')!.platform = 'quark'
    f.set('b', 'root', [file('same', 'root', { accountId: 'b', platform: 'quark', raw: { etag: 'a'.repeat(32) } })])
    const result = ok(await f.service.verifyEvidence({ refs: references }))
    expect(result.results[1].status).toBe('unavailable')
    expect(ok(await f.service.listDuplicateGroups({})).items[0].status).toBe('candidate')
    f.store.saveEvidence(f.store.member(references[1])!, { algorithm: 'sha1', value: 'a'.repeat(40) })
    expect(ok(await f.service.listDuplicateGroups({})).items[0].status).toBe('candidate')
    expect(ok(await f.service.createPlan(planInput)).plan.candidateReleaseBytes).toBe(100)
  })
  it('invalidates evidence after a rescan and rejects changed or out-of-filter plan items', async () => {
    const f = await duplicates()
    ok(await f.service.verifyEvidence({ refs: references })); f.advance()
    const scope = f.catalogStore.listScopes().find(scope => scope.accountId === 'b')!
    await f.scan(scope.id)
    expect(f.store.member(references[1])!.evidence).toBeNull()
    expect(ok(await f.service.listDuplicateGroups({})).items[0].status).toBe('candidate')
    expect(await f.service.createPlan({ ...planInput, accountIds: ['a'] })).toMatchObject({ success: false })
    expect(await f.service.createPlan({ ...planInput, remove: references })).toMatchObject({ success: false, error: expect.stringContaining('保留副本') })
    f.set('b', 'root', [file('same', 'root', { accountId: 'b', size: 101 })]); f.advance(); await f.scan(scope.id)
    expect(await f.service.createPlan(planInput)).toMatchObject({ success: false, error: expect.stringContaining('已变化') })
  })
  it('rejects races and unavailable accounts during evidence acquisition without leaking raw errors', async () => {
    const f = await duplicates()
    f.readMetadata.mockImplementationOnce(async entry => { f.db.prepare('UPDATE catalog_entries SET indexed_at=indexed_at+1 WHERE account_id=? AND file_id=?').run(entry.accountId, entry.fileId); return file('same', 'root', { raw: { etag: 'a'.repeat(32) } }) })
    expect(ok(await f.service.verifyEvidence({ refs: [references[0]] })).results[0]).toMatchObject({ status: 'error', message: expect.stringContaining('已变化') })
    expect(f.store.member(references[0])!.evidence).toBeNull()
    f.readMetadata.mockRejectedValueOnce(new Error('Bearer SECRET https://private.invalid'))
    expect(JSON.stringify(await f.service.verifyEvidence({ refs: [references[0]] }))).not.toContain('SECRET')
    f.accounts.get('a')!.status = 'expired'
    expect(ok(await f.service.verifyEvidence({ refs: [references[0]] })).results[0].status).toBe('error')
  })
  it('exports only a review manifest and escapes spreadsheet formulas in user-controlled paths', async () => {
    const f = await duplicates(), plan = ok(await f.service.createPlan(planInput)).plan
    plan.keep.accountNickname = '=HYPERLINK("https://example.invalid")'
    plan.review[0].path = '+formula,with"quotes'
    const csv = serializeStoragePlan(plan, 'csv')
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"')
    expect(csv).toContain('"\'+formula,with""quotes"')
    expect(csv).toContain('review-before-cleanup'); expect(csv).toContain('candidate')
    expect(serializeStoragePlan(plan, 'json')).not.toContain('credential')
  })
  it('refreshes quotas only explicitly and retains timestamps and signed differences', async () => {
    const f = await duplicates()
    expect(ok(await f.service.summary({})).summary.accounts[0].quota).toBeNull()
    ok(await f.service.refreshQuotas({ accountIds: ['a'] }))
    expect(ok(await f.service.summary({})).summary.accounts[0]).toMatchObject({ quota: { used: 3000, checkedAt: 1000 }, quotaDifference: 2900 })
    f.getQuota.mockRejectedValueOnce(new Error('quota token SECRET'))
    const results = ok(await f.service.refreshQuotas({ accountIds: ['a'] })).results
    expect(results[0].success).toBe(false); expect(JSON.stringify(results)).not.toContain('SECRET')
    expect(ok(await f.service.summary({})).summary.accounts[0].quota?.checkedAt).toBe(1000)
    f.getQuota.mockResolvedValueOnce({ used: 0, total: 10000 }); ok(await f.service.refreshQuotas({ accountIds: ['a'] }))
    expect(ok(await f.service.summary({})).summary.accounts[0].quotaDifference).toBe(-100)
  })
  it('bounds pages and selections and rejects malformed IPC values', async () => {
    const f = await duplicates()
    for (const value of [null, [], { page: 0 }, { pageSize: 101 }, { page: Infinity }, { accountIds: [null] }, { fileTypes: ['sql'] }]) {
      expect(await f.service.listLargeFiles(value as never)).toMatchObject({ success: false })
    }
    expect(await f.service.verifyEvidence({ refs: Array.from({ length: 51 }, () => references[0]) })).toMatchObject({ success: false })
    expect(await f.service.listGroupMembers({ group: { name: "' OR 1=1 --", size: 100 } })).toMatchObject({ success: true, total: 0 })
    expect(await f.service.listDuplicateGroups({ status: 'unknown' } as never)).toMatchObject({ success: false })
    expect(await f.service.exportPlan({ ...planInput, format: 'exe' } as never)).toMatchObject({ success: false })
  })
})
