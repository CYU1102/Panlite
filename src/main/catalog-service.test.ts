import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CatalogQuery, CatalogResult, CatalogScope } from '../shared/catalog'
import type { FileItem, FileListResult } from '../shared/types'
import { CatalogService } from './catalog-service'
import { CatalogStore, initializeCatalogSchema, type CatalogAccount } from './catalog-store'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function success<T extends object>(result: CatalogResult<T>): T {
  if (!result.success) throw new Error(result.error)
  return result
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function file(id: string, parentId = 'root', options: Partial<FileItem> = {}): FileItem {
  return { id, parentId, name: id + '.txt', isDir: false, size: 100, createdAt: 1, updatedAt: 2, accountId: 'a', platform: 'webdav', ...options }
}
function listing(parentId: string, files: FileItem[], hasMore = false): FileListResult { return { parentId, files, hasMore } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-catalog-test-')), filename = join(directory, 'isolated.sqlite')
  let db = new Database(filename)
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); initializeCatalogSchema(db)
  let store = new CatalogStore(db)
  const accounts = new Map<string, CatalogAccount>([['a', { id: 'a', nickname: '甲账号', platform: 'webdav', status: 'active' }]])
  const trees = new Map<string, FileListResult | Error>()
  const listFiles = vi.fn(async (accountId: string, parentId: string): Promise<FileListResult> => {
    const value = trees.get(accountId + ':' + parentId)
    if (value instanceof Error) throw value
    return value ?? listing(parentId, [])
  })
  const deps = { getAccount: (id: string) => accounts.get(id), listFiles }
  let service = new CatalogService(store, deps)
  cleanups.push(() => { service.dispose(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    accounts, trees, listFiles,
    get db() { return db }, get store() { return store }, get service() { return service },
    async scope(accountId = 'a', rootId = 'root', rootPath = '/'): Promise<CatalogScope> {
      return success(await service.addScope({ accountId, rootId, rootPath })).scope
    },
    async scan(scopeId: string): Promise<void> { success(await service.startScan(scopeId)); await service.waitForIdle() },
    async entries(query: CatalogQuery = {}) { return success(await service.search(query)).entries },
    async reopen(): Promise<void> {
      service.dispose(); await service.waitForIdle(); db.close()
      db = new Database(filename); db.pragma('foreign_keys=ON'); initializeCatalogSchema(db)
      store = new CatalogStore(db); service = new CatalogService(store, deps)
    },
  }
}

describe('persistent catalog scans', () => {
  it.each([['baidu', '/'], ['aliyun_web', 'root'], ['xunlei', '']] as const)('accepts only the known %s root alias and stores the requested parent identity', async (platform, alias) => {
    const f = fixture()
    f.accounts.get('a')!.platform = platform
    const scope = await f.scope('a', '0', '/')
    f.trees.set('a:0', listing('0', [file('root-child', alias, { platform })]))
    await f.scan(scope.id)
    expect((await f.entries())[0]).toMatchObject({ fileId: 'root-child', parentId: '0', platform })
    expect(await f.service.resolveEntry({ accountId: 'a', fileId: 'root-child' })).toMatchObject({ success: true })
    f.trees.set('a:0', listing('0', [file('other', 'wrong-parent', { platform })]))
    await f.scan(scope.id)
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['root-child'])
    expect(f.store.getScope(scope.id)?.status).toBe('error')
    const nested = await f.scope('a', 'subdir', '/subdir')
    f.trees.set('a:subdir', listing('subdir', [file('bad-alias', alias, { platform })]))
    await f.scan(nested.id)
    expect(f.store.getScope(nested.id)?.status).toBe('error')
  })

  it('scans BFS, replaces complete directories and retains local annotations across rescans', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true, name: '项目' }), file('removed')]))
    f.trees.set('a:dir', listing('dir', [file('nested', 'dir', { name: '计划.txt' })]))
    await f.scan(scope.id)
    expect(f.listFiles.mock.calls.map(call => call[1])).toEqual(['root', 'dir'])
    expect((await f.entries()).map(entry => entry.path)).toContain('/项目/计划.txt')
    success(await f.service.setTags({ accountId: 'a', fileId: 'nested', tags: ['工作', '工作'] }))
    success(await f.service.setFavorite({ accountId: 'a', fileId: 'nested', favorite: true }))
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true, name: '项目' }), file('added')]))
    await f.scan(scope.id)
    expect((await f.entries()).map(entry => entry.fileId).sort()).toEqual(['added', 'dir', 'nested'])
    expect((await f.entries({ favorite: true }))[0]).toMatchObject({ fileId: 'nested', tags: ['工作'], favorite: true })
    expect(f.store.getScope(scope.id)).toMatchObject({ status: 'completed', scannedDirectories: 2, pendingDirectories: 0, failedDirectories: 0, entryCount: 3 })
  })

  it('preserves a failed subtree while removing confirmed siblings, and retries failures after restart', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true }), file('gone')]))
    f.trees.set('a:dir', listing('dir', [file('keep', 'dir')]))
    await f.scan(scope.id)
    const lastComplete = f.store.getScope(scope.id)!.lastCompletedAt
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true }), file('new')]))
    f.trees.set('a:dir', new Error('Authorization: Bearer SECRET_TOKEN https://secret.invalid'))
    await f.scan(scope.id)
    expect((await f.entries()).map(entry => entry.fileId).sort()).toEqual(['dir', 'keep', 'new'])
    expect(f.store.getScope(scope.id)).toMatchObject({ status: 'partial', failedDirectories: 1, lastCompletedAt: lastComplete })
    expect(JSON.stringify(await f.service.listScopes())).not.toContain('SECRET_TOKEN')
    await f.reopen()
    f.trees.set('a:dir', listing('dir', [file('retry', 'dir')]))
    success(await f.service.resumeScan(scope.id)); await f.service.waitForIdle()
    expect((await f.entries()).map(entry => entry.fileId).sort()).toEqual(['dir', 'new', 'retry'])
    expect(f.store.getScope(scope.id)?.status).toBe('completed')
  })

  it.each(['hasMore', 'missingHasMore', 'wrongParent', 'wrongAccount', 'duplicate', 'cycle', 'invalidSize'] as const)('keeps old directory contents for %s', async kind => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('keep')]))
    await f.scan(scope.id)
    const result = listing('root', [file('fresh')])
    if (kind === 'hasMore') result.hasMore = true
    if (kind === 'missingHasMore') delete (result as Partial<FileListResult>).hasMore
    if (kind === 'wrongParent') result.parentId = 'elsewhere'
    if (kind === 'wrongAccount') result.files[0].accountId = 'other'
    if (kind === 'duplicate') result.files.push(file('fresh'))
    if (kind === 'cycle') result.files = [file('root', 'root', { isDir: true })]
    if (kind === 'invalidSize') result.files[0].size = NaN
    f.trees.set('a:root', result); await f.scan(scope.id)
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['keep'])
    expect(f.store.getScope(scope.id)).toMatchObject({ status: 'error', failedDirectories: 1 })
  })

  it('pauses immediately and ignores a late listing, then resumes the persisted cursor', async () => {
    const f = fixture(), scope = await f.scope(), request = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementationOnce(async () => { requested.resolve(); return request.promise })
    success(await f.service.startScan(scope.id)); await requested.promise
    success(await f.service.pauseScan(scope.id))
    request.resolve(listing('root', [file('late')]))
    await f.service.waitForIdle()
    expect(await f.entries()).toEqual([])
    expect(f.store.getScope(scope.id)).toMatchObject({ status: 'paused', pendingDirectories: 1, scannedDirectories: 0 })
    await f.reopen(); await f.service.recoverInterruptedScans(); await f.service.waitForIdle()
    expect(f.listFiles).toHaveBeenCalledTimes(1)
    f.trees.set('a:root', listing('root', [file('resumed')]))
    success(await f.service.resumeScan(scope.id)); await f.service.waitForIdle()
    expect((await f.entries())[0].fileId).toBe('resumed')
  })

  it('recovers only authorized running work after process termination, preserving BFS progress', async () => {
    const f = fixture(), scope = await f.scope(), idle = await f.scope('a', 'unselected', '/未扫描')
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true })]))
    const request = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementation(async (_accountId, parentId) => {
      if (parentId === 'root') return f.trees.get('a:root') as FileListResult
      requested.resolve(); return request.promise
    })
    success(await f.service.startScan(scope.id)); await requested.promise
    f.service.dispose(); request.resolve(listing('dir', [file('late', 'dir')])); await f.service.waitForIdle()
    expect(f.store.getScope(scope.id)).toMatchObject({ status: 'running', scannedDirectories: 1, pendingDirectories: 1 })
    await f.reopen()
    f.listFiles.mockImplementation(async (_accountId, parentId) => listing(parentId, [file('restart', parentId)]))
    f.listFiles.mockClear(); await f.service.recoverInterruptedScans(); await f.service.waitForIdle()
    expect(f.listFiles.mock.calls.map(call => call[1])).toEqual(['dir'])
    expect((await f.entries()).map(entry => entry.fileId).sort()).toEqual(['dir', 'restart'])
    expect(f.store.getScope(idle.id)?.status).toBe('idle')
  })

  it('invalidates the prior generation when a new rescan races an old response', async () => {
    const f = fixture(), scope = await f.scope(), old = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementationOnce(async () => { requested.resolve(); return old.promise })
    success(await f.service.startScan(scope.id)); await requested.promise
    f.trees.set('a:root', listing('root', [file('current')]))
    success(await f.service.startScan(scope.id)); old.resolve(listing('root', [file('stale')]))
    await f.service.waitForIdle()
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['current'])
  })

  it('abandons an unresponsive paused request so a different scope can finish', async () => {
    const f = fixture(), first = await f.scope(), second = await f.scope('a', 'second', '/second')
    const stalled = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementationOnce(async () => { requested.resolve(); return stalled.promise })
    success(await f.service.startScan(first.id)); await requested.promise
    success(await f.service.pauseScan(first.id))
    f.trees.set('a:second', listing('second', [file('new', 'second')]))
    success(await f.service.startScan(second.id)); await f.service.waitForIdle()
    expect(f.store.getScope(second.id)?.status).toBe('completed')
    stalled.resolve(listing('root', [file('late')]))
    await Promise.resolve()
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['new'])
  })

  it('restarts a partially staged large directory without exposing uncommitted children or retaining abandoned candidates', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('previous')]))
    await f.scan(scope.id)
    let paused = false
    const service = new CatalogService(f.store, {
      getAccount: id => f.accounts.get(id), listFiles: f.listFiles,
      yieldControl: async () => {
        const candidates = (f.db.prepare('SELECT COUNT(*) count FROM catalog_candidates').get() as { count: number }).count
        if (candidates && !paused) { paused = true; success(await service.pauseScan(scope.id)) }
      },
    })
    f.trees.set('a:root', listing('root', Array.from({ length: 1200 }, (_, index) => file('abandoned-' + index))))
    success(await service.startScan(scope.id)); await service.waitForIdle()
    expect(paused).toBe(true)
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['previous'])
    f.trees.set('a:root', listing('root', [file('confirmed')]))
    success(await service.resumeScan(scope.id)); await service.waitForIdle(); service.dispose()
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['confirmed'])
    expect(f.db.prepare('SELECT COUNT(*) count FROM catalog_candidates').get()).toEqual({ count: 0 })
    expect(f.db.prepare('SELECT COUNT(*) count FROM catalog_entries').get()).toEqual({ count: 1 })
  })

  it('drops obsolete descendants when a provider replaces a directory identity with a regular file', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('dir', 'root', { isDir: true })]))
    f.trees.set('a:dir', listing('dir', [file('child', 'dir')]))
    await f.scan(scope.id)
    f.trees.set('a:root', listing('root', [file('dir')]))
    await f.scan(scope.id)
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['dir'])
  })

  it('rewrites a moved subtree and overlapping roots, preserving descendants when the moved folder fails to list', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('A', 'root', { name: 'A', isDir: true }), file('B', 'root', { name: 'B', isDir: true })]))
    f.trees.set('a:A', listing('A', [file('D', 'A', { name: '资料', isDir: true })]))
    f.trees.set('a:D', listing('D', [file('child', 'D', { name: '文档.txt' })]))
    await f.scan(scope.id)
    const nested = await f.scope('a', 'D', '/A/资料'); await f.scan(nested.id)
    f.trees.set('a:A', listing('A', []))
    f.trees.set('a:B', listing('B', [file('D', 'B', { name: '资料改名', isDir: true })]))
    f.trees.set('a:D', new Error('offline'))
    await f.scan(scope.id)
    expect((await f.entries()).find(entry => entry.fileId === 'child')?.path).toBe('/B/资料改名/文档.txt')
    expect(f.store.getScope(nested.id)?.rootPath).toBe('/B/资料改名')
    expect(f.store.getScope(scope.id)?.status).toBe('partial')
    success(await f.service.removeScope(scope.id))
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['child'])
  })

  it('retains overlapping coverage until each scope confirms deletion, without duplicate search results', async () => {
    const f = fixture(), broad = await f.scope()
    f.trees.set('a:root', listing('root', [file('D', 'root', { name: 'D', isDir: true })]))
    f.trees.set('a:D', listing('D', [file('child', 'D')]))
    await f.scan(broad.id)
    const nested = await f.scope('a', 'D', '/D'); await f.scan(nested.id)
    expect(success(await f.service.search({})).total).toBe(2)
    f.trees.set('a:D', listing('D', [])); await f.scan(broad.id)
    expect((await f.entries({ scopeIds: [broad.id] })).map(entry => entry.fileId)).toEqual(['D'])
    expect((await f.entries()).map(entry => entry.fileId)).toContain('child')
    await f.scan(nested.id)
    expect((await f.entries()).map(entry => entry.fileId)).toEqual(['D'])
  })

  it('removes account data and rejects in-flight resurrection without touching an account with the same file IDs', async () => {
    const f = fixture()
    f.accounts.set('b', { id: 'b', platform: 'webdav', nickname: '乙账号', status: 'active' })
    const first = await f.scope(), second = await f.scope('b')
    f.trees.set('a:root', listing('root', [file('same')]))
    f.trees.set('b:root', listing('root', [file('same', 'root', { accountId: 'b' })]))
    await f.scan(first.id); await f.scan(second.id)
    success(await f.service.setFavorite({ accountId: 'a', fileId: 'same', favorite: true }))
    expect((await f.entries({ favorite: true })).map(entry => entry.accountId)).toEqual(['a'])
    const request = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementationOnce(async () => { requested.resolve(); return request.promise })
    success(await f.service.startScan(first.id)); await requested.promise
    f.accounts.delete('a'); f.service.removeAccount('a'); request.resolve(listing('root', [file('resurrected')]))
    await f.service.waitForIdle()
    expect((await f.entries()).map(entry => [entry.accountId, entry.fileId])).toEqual([['b', 'same']])
    expect(f.store.getScope(first.id)).toBeUndefined()
    expect(f.db.prepare('SELECT * FROM catalog_entries WHERE account_id=?').all('a')).toEqual([])
  })

  it('handles account removal detected after await and removes stale accounts during startup', async () => {
    const f = fixture(), scope = await f.scope(), request = deferred<FileListResult>(), requested = deferred<void>()
    f.listFiles.mockImplementationOnce(async () => { requested.resolve(); return request.promise })
    success(await f.service.startScan(scope.id)); await requested.promise
    f.accounts.delete('a'); request.resolve(listing('root', [file('late')]))
    await f.service.waitForIdle(); expect(f.store.accountIds()).toEqual([])
    f.accounts.set('a', { id: 'a', nickname: 'a', platform: 'webdav', status: 'active' }); await f.scope()
    f.accounts.delete('a'); await f.reopen(); await f.service.recoverInterruptedScans()
    expect(f.store.listScopes()).toEqual([])
  })
})

describe('local catalog queries and annotations', () => {
  it('supports Chinese short literals, literal wildcards, combined filters and stable server-side pagination offline', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [
      file('1', 'root', { name: '中期计划.pdf', size: 300, updatedAt: 10 }), file('2', 'root', { name: '中心照片.JPG', size: 400, updatedAt: 20 }),
      file('3', 'root', { name: '100%_Budget.TXT', size: 200, updatedAt: 30 }), file('4', 'root', { name: 'Other.zip', size: 100, updatedAt: 40 }),
    ]))
    await f.scan(scope.id)
    success(await f.service.setTags({ accountId: 'a', fileId: '1', tags: ['工作', '重要'] }))
    success(await f.service.setFavorite({ accountId: 'a', fileId: '1', favorite: true }))
    f.listFiles.mockRejectedValue(new Error('offline')); f.listFiles.mockClear()
    expect((await f.entries({ keyword: '中' })).length).toBe(2)
    expect((await f.entries({ keyword: '中心' })).length).toBe(1)
    expect((await f.entries({ keyword: '%_' })).map(entry => entry.fileId)).toEqual(['3'])
    expect((await f.entries({ keyword: 'budget' })).map(entry => entry.fileId)).toEqual(['3'])
    expect((await f.entries({ keyword: '中', path: '计划', fileTypes: ['document'], accountIds: ['a'], scopeIds: [scope.id], minSize: 300, maxSize: 300, dateFrom: 10, dateTo: 10, favorite: true, tags: ['工作', '重要'] })).map(entry => entry.fileId)).toEqual(['1'])
    const pages = await Promise.all([1, 2].map(page => f.service.search({ page, pageSize: 2, sortBy: 'size', sortOrder: 'asc' })))
    expect(pages.map(page => success(page).entries.map(entry => entry.fileId))).toEqual([['4', '3'], ['1', '2']])
    expect(success(pages[0]).total).toBe(4)
    expect(f.listFiles).not.toHaveBeenCalled()
  })

  it('persists collections, tags and favorites across reopen, with account-scoped membership', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('item', 'root', { raw: { credential: 'SECRET' } })])); await f.scan(scope.id)
    const collection = success(await f.service.saveCollection({ name: '我的资料' })).collection
    success(await f.service.setEntryCollections({ accountId: 'a', fileId: 'item', collectionIds: [collection.id] }))
    success(await f.service.setTags({ accountId: 'a', fileId: 'item', tags: ['项目'] }))
    success(await f.service.setFavorite({ accountId: 'a', fileId: 'item', favorite: true }))
    await f.reopen()
    const result = await f.entries({ collectionId: collection.id, favorite: true, tags: ['项目'] })
    expect(result).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(success(await f.service.listCollections()).collections[0].entryCount).toBe(1)
    expect(success(await f.service.listTags()).tags).toEqual(['项目'])
    success(await f.service.saveCollection({ id: collection.id, name: '已更名' }))
    success(await f.service.removeCollection(collection.id))
    expect((await f.entries())[0].collectionIds).toEqual([])
  })

  it('retains local annotations after removing/re-adding the indexed range', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('item')]))
    await f.scan(scope.id); success(await f.service.setTags({ accountId: 'a', fileId: 'item', tags: ['保留'] }))
    success(await f.service.removeScope(scope.id)); expect(await f.entries()).toEqual([])
    await f.scan((await f.scope()).id)
    expect((await f.entries())[0].tags).toEqual(['保留'])
  })

  it.each([null, { page: 0 }, { pageSize: 201 }, { pageSize: 1.5 }, { minSize: -1 }, { minSize: 2, maxSize: 1 }, { dateFrom: 2, dateTo: 1 }, { sortBy: 'name; DROP TABLE catalog_entries' }, { fileTypes: ['unsupported'] }, { tags: [''] }, { favorite: 'yes' }] as unknown[])('validates malformed query %j', async input => {
    const f = fixture()
    expect((await f.service.search(input as CatalogQuery)).success).toBe(false)
    expect(f.db.prepare('SELECT COUNT(*) count FROM catalog_entries').get()).toEqual({ count: 0 })
  })

  it('validates all mutation inputs and does not discard existing membership on invalid collections', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('item')]))
    await f.scan(scope.id)
    const collection = success(await f.service.saveCollection({ name: 'Valid' })).collection
    success(await f.service.setEntryCollections({ accountId: 'a', fileId: 'item', collectionIds: [collection.id] }))
    expect(await f.service.setEntryCollections({ accountId: 'a', fileId: 'item', collectionIds: ['missing'] })).toMatchObject({ success: false })
    expect((await f.entries())[0].collectionIds).toEqual([collection.id])
    expect(await f.service.saveCollection({ name: 'Valid' })).toMatchObject({ success: false })
    expect(await f.service.addScope({ accountId: 'missing', rootId: 'root', rootPath: '/' })).toMatchObject({ success: false })
    expect(await f.service.addScope({ accountId: 'a', rootId: 'root', rootPath: '/../bad' })).toMatchObject({ success: false })
    expect(await f.service.pauseScan(scope.id)).toMatchObject({ success: false })
    expect(await f.service.resumeScan(scope.id)).toMatchObject({ success: false })
    expect(await f.service.setTags({ accountId: 'b', fileId: 'item', tags: ['tag'] })).toMatchObject({ success: false })
    expect(await f.service.setFavorite({ accountId: 'a', fileId: 'item', favorite: 'yes' as never })).toMatchObject({ success: false })
  })

  it('revalidates the remote object before returning a location, without exposing raw adapter data', async () => {
    const f = fixture(), scope = await f.scope()
    f.trees.set('a:root', listing('root', [file('item', 'root', { raw: { token: 'SECRET' } })])); await f.scan(scope.id)
    const identity = { accountId: 'a', fileId: 'item' }
    expect(JSON.stringify(success(await f.service.resolveEntry(identity)))).not.toContain('SECRET')
    f.trees.set('a:root', listing('root', [file('item', 'root', { size: 101 })]))
    expect(await f.service.resolveEntry(identity)).toMatchObject({ success: false, error: expect.stringContaining('已变化') })
    f.trees.set('a:root', listing('root', []))
    expect(await f.service.resolveEntry(identity)).toMatchObject({ success: false })
    f.accounts.get('a')!.status = 'expired'
    expect((await f.entries())[0].accountStatus).toBe('expired')
    expect(await f.service.startScan(scope.id)).toMatchObject({ success: false })
    expect(await f.service.resolveEntry(identity)).toMatchObject({ success: false })
  })
})
