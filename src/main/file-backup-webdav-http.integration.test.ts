import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount, TaskStatus } from '../shared/types'
import type { FileBackupResult, FileBackupSnapshot } from '../shared/file-backup'
import type { DbTask } from './db'
import type { TaskExtensionContext } from './task-extensions'
import { FileBackupStore, initializeFileBackupSchema } from './file-backup-store'
import { FileBackupService, type FileBackupDependencies } from './file-backup-service'
import { executeFileBackupTask, executeFileRestoreTask, executeFileBackupPruneTask } from './file-backup-executor'
import { startDavHttpServer } from './test-fixtures/webdav-http-server'

const bridge = vi.hoisted(() => ({ db: undefined as Database.Database | undefined, origins: new Set<string>() }))
vi.mock('./db', () => ({ getDb: () => bridge.db }))
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }))
// Only Electron's transport is replaced. Every adapter method, header, XML parser,
// stream, HTTP response and executor operation is production code.
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => {
  if (!bridge.origins.has(new URL(url).origin)) throw new Error('Fixture forbids non-loopback network access')
  const streaming = init?.body && typeof (init.body as ReadableStream).getReader === 'function'
  return globalThis.fetch(url, { ...init, ...(streaming ? { duplex: 'half' } : {}) } as RequestInit)
} } }))
import { webdavAdapter } from '../adapters/webdav'
import { runTaskOperation } from './task-operations'

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
function ok<T extends object>(result: FileBackupResult<T>): T { if (!result.success) throw new Error(result.error); return result }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-dav-http-backup-')), source = path.join(root, 'source'), temporary = path.join(root, 'temporary'), database = path.join(root, 'db.sqlite')
  await fs.mkdir(source); await fs.mkdir(temporary)
  const server = await startDavHttpServer(path.join(root, 'remote')); bridge.origins.add(server.origin)
  const account: DriveAccount = { id: randomUUID(), platform: 'webdav', nickname: 'Loopback DAV', loginType: 'password', status: 'active', createdAt: 0, updatedAt: 0,
    credential: { serverUrl: server.url, username: server.username, password: server.password } }
  const initialize = (db: Database.Database): void => {
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); initializeFileBackupSchema(db)
    db.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT,execution_token TEXT,payload TEXT,type TEXT);
      CREATE TABLE IF NOT EXISTS task_operations(task_id TEXT,operation_key TEXT,execution_token TEXT,status TEXT,result_json TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(task_id,operation_key));`)
  }
  let db = new Database(database); initialize(db); bridge.db = db
  let store = new FileBackupStore(db)
  const dependencies: FileBackupDependencies = {
    getAccount: id => id === account.id ? account : undefined, getAdapter: () => webdavAdapter,
    getTaskStatus: id => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: TaskStatus } | undefined)?.status,
    enqueueTask: input => { const id = randomUUID(); db.prepare("INSERT INTO tasks(id,status,payload,type) VALUES(?,'pending',?,?)").run(id, JSON.stringify(input.payload), input.type); return id },
  }
  let service = new FileBackupService(store, dependencies)
  cleanups.push(async () => {
    service.dispose(); db.close(); bridge.db = undefined; await server.close(); bridge.origins.delete(server.origin)
    const absolute = path.resolve(root)
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('panlite-dav-http-backup-') || (await fs.lstat(absolute)).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 3 })
    expect(server.errors).toEqual([])
  })
  const f = {
    root, source, server, account,
    get db() { return db }, get store() { return store }, get service() { return service },
    async write(relative: string, bytes: string): Promise<void> { const file = path.join(source, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes) },
    async plan() { return ok(await service.savePlan({ name: 'HTTP 协议备份', sourcePath: source, target: { accountId: account.id, rootId: '0', rootPath: '/' }, exclude: [], keepLast: 1, keepDays: 0 })).plan },
    async prepare(planId: string) { const preview = ok(await service.previewBackup(planId)).preview; expect(preview.executable).toBe(true); return ok(await service.executeBackup({ planId, previewId: preview.id })) },
    async run(taskId: string): Promise<void> {
      const token = randomUUID(), controller = new AbortController()
      db.prepare("UPDATE tasks SET status='running',execution_token=? WHERE id=?").run(token, taskId)
      const row = db.prepare('SELECT payload,type FROM tasks WHERE id=?').get(taskId) as { payload: string; type: string }
      const task: DbTask = { id: taskId, account_id: account.id, platform: 'webdav', task_type: row.type, title: '', payload: row.payload, status: 'running', progress: 0,
        retry_count: 0, error_message: null, execution_token: token, created_at: 0, updated_at: 0, finished_at: null }
      const context: TaskExtensionContext = { task, signal: controller.signal,
        assertActive: () => {
          if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND execution_token=? AND status='running'").get(task.id, token)) throw new Error('Task superseded')
        }, operation: (kind, item, execute) => runTaskOperation(task, kind, item, execute), progress() {}, log() {} }
      try {
        const executor = row.type === 'file_backup' ? executeFileBackupTask : row.type === 'file_restore' ? executeFileRestoreTask : executeFileBackupPruneTask
        await executor(context, { service, tempRoot: temporary })
        db.prepare("UPDATE tasks SET status='success' WHERE id=? AND execution_token=?").run(taskId, token)
      } catch (error) { db.prepare("UPDATE tasks SET status='failed' WHERE id=? AND execution_token=?").run(taskId, token); throw error }
    },
    async backup(planId: string): Promise<FileBackupSnapshot> { const result = await f.prepare(planId); if (result.taskId) await f.run(result.taskId); return store.snapshot(result.snapshot.id)! },
    async restore(snapshotId: string, name: string, relativePaths?: string[]): Promise<string> {
      const targetPath = path.join(root, name), preview = ok(await service.previewRestore({ snapshotId, targetPath, relativePaths })).preview
      expect(preview.executable).toBe(true); await f.run(ok(await service.executeRestore(preview.id)).taskId); return targetPath
    },
    reopen(): void { service.dispose(); db.close(); db = new Database(database); initialize(db); bridge.db = db; store = new FileBackupStore(db); service = new FileBackupService(store, dependencies) },
  }
  return f
}

describe('real WebDAV HTTP transport + backup service/executors + SQLite operation journal', () => {
  it('round-trips versions, incremental changes, source deletion, full/selected restores, and shared-reference retention over DAV HTTP', async () => {
    const f = await fixture(); await f.write('中文 & 空格/记录.txt', '版本一'); await f.write('共享.txt', 'shared content'); await fs.mkdir(path.join(f.source, '空目录'))
    expect(await webdavAdapter.checkLogin(f.account)).toBe(true)
    const plan = await f.plan(), first = await f.backup(plan.id)
    const firstPuts = f.server.requests.filter(request => request.method === 'PUT'); expect(firstPuts).toHaveLength(3)
    for (const object of f.store.snapshotObjects(first.id)) {
      expect(sha(await f.server.read(object.remoteId!))).toBe(object.sha256)
      expect(f.server.requests.some(request => request.method === 'GET' && request.path === object.remoteId && request.bytes === object.size)).toBe(true)
    }
    const beforeUnchanged = f.server.requests.length, unchanged = await f.prepare(plan.id)
    expect(unchanged).toMatchObject({ unchanged: true, snapshot: { id: first.id } })
    expect(f.server.requests.slice(beforeUnchanged).filter(request => request.method === 'PUT')).toHaveLength(0)
    expect(f.server.requests.slice(beforeUnchanged).filter(request => request.method === 'GET')).toHaveLength(3)
    await f.write('中文 & 空格/记录.txt', '版本二'); const second = await f.backup(plan.id)
    expect(f.server.requests.filter(request => request.method === 'PUT')).toHaveLength(5)
    await fs.unlink(path.join(f.source, '中文 & 空格/记录.txt')); const third = await f.backup(plan.id)
    expect(f.server.requests.filter(request => request.method === 'PUT')).toHaveLength(6)
    const full = await f.restore(first.id, 'full'), selected = await f.restore(second.id, 'selected-file', ['中文 & 空格/记录.txt'])
    const selectedDirectory = await f.restore(first.id, 'selected-directory', ['中文 & 空格'])
    expect(sha(await fs.readFile(path.join(full, '中文 & 空格/记录.txt')))).toBe(sha('版本一'))
    expect((await fs.stat(path.join(full, '空目录'))).isDirectory()).toBe(true)
    expect(sha(await fs.readFile(path.join(selected, '中文 & 空格/记录.txt')))).toBe(sha('版本二'))
    expect(await fs.readdir(selected)).toEqual(['中文 & 空格'])
    expect(sha(await fs.readFile(path.join(selectedDirectory, '中文 & 空格/记录.txt')))).toBe(sha('版本一'))
    const shared = f.store.entries(first.id).find(entry => entry.relativePath === '共享.txt')!.objectId!, sharedRemote = f.store.object(shared)!.remoteId!
    expect(f.store.references(shared)).toHaveLength(3)
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [first.id] })).preview
    expect(preview.objectCount).toBe(2)
    await f.run(ok(await f.service.prune(preview.id)).taskId)
    expect(f.store.snapshot(first.id)?.status).toBe('deleted'); expect(await f.server.exists(sharedRemote)).toBe(true)
    expect(f.server.requests.filter(request => request.method === 'DELETE')).toHaveLength(2)
    const remaining = await f.restore(third.id, 'remaining'); expect(sha(await fs.readFile(path.join(remaining, '共享.txt')))).toBe(sha('shared content'))
    expect(f.server.requests.every(request => request.authenticated)).toBe(true)
    expect(f.server.requests.filter(request => request.method === 'PUT').every(request => request.ifNoneMatch === '*' && request.committed)).toBe(true)
    expect(f.db.prepare("SELECT COUNT(*) count FROM task_operations WHERE status='started'").get()).toEqual({ count: 0 })
  }, 30_000)

  it('reconciles a real socket loss after committed PUT by GET hashing after SQLite reopen, without a second PUT', async () => {
    const f = await fixture(); await f.write('payload.txt', 'socket loss bytes'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.server.fault({ method: 'PUT', mode: 'drop-after-commit' })
    await expect(f.run(run.taskId!)).rejects.toThrow()
    const original = f.server.requests.find(request => request.method === 'PUT')!
    expect(original).toMatchObject({ committed: true, bytes: Buffer.byteLength('socket loss bytes') }); expect(original.status).toBeUndefined()
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('uncertain')
    expect(f.db.prepare("SELECT COUNT(*) count FROM task_operations WHERE status='started'").get()).toEqual({ count: 1 })
    f.reopen(); await f.run(run.taskId!)
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
    expect(f.server.requests.filter(request => request.method === 'PUT' && request.path === original.path)).toHaveLength(1)
    expect(sha(await f.server.read(original.path))).toBe(sha('socket loss bytes'))
  }, 15_000)

  it('retains an HTTP 503 PUT as unresolved and never resends it during retry', async () => {
    const f = await fixture(); await f.write('payload.txt', 'unconfirmed'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.server.fault({ method: 'PUT', mode: 'http-503' }); await expect(f.run(run.taskId!)).rejects.toThrow()
    const sent = f.server.requests.find(request => request.method === 'PUT')!
    expect(sent).toMatchObject({ status: 503, committed: false }); expect(await f.server.exists(sent.path)).toBe(false)
    f.reopen(); await expect(f.run(run.taskId!)).rejects.toThrow()
    expect(f.server.requests.filter(request => request.method === 'PUT')).toHaveLength(1); expect(f.store.snapshot(run.snapshot.id)?.status).not.toBe('ready')
  }, 15_000)

  it('does not publish ready after a truncated HTTP GET body, and retries only readback', async () => {
    const f = await fixture(); await f.write('payload.txt', 'a complete body must arrive'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.server.fault({ method: 'GET', mode: 'truncated-get' }); await expect(f.run(run.taskId!)).rejects.toThrow()
    expect(f.store.snapshot(run.snapshot.id)?.status).not.toBe('ready')
    const objectPath = f.server.requests.find(request => request.method === 'PUT')!.path
    f.reopen(); await f.run(run.taskId!)
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready'); expect(f.server.requests.filter(request => request.method === 'PUT' && request.path === objectPath)).toHaveLength(1)
  }, 15_000)

  it.each(['drop-after-commit', 'http-503', 'truncated-mutation'] as const)('reconciles DELETE %s without repeating an unknown delete or removing retained references', async mode => {
    const f = await fixture(); await f.write('shared.txt', 'shared'); await f.write('changed.txt', 'old'); const plan = await f.plan(), old = await f.backup(plan.id)
    await f.write('changed.txt', 'new'); const current = await f.backup(plan.id)
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [old.id] })).preview, run = ok(await f.service.prune(preview.id))
    f.server.fault({ method: 'DELETE', mode }); await expect(f.run(run.taskId)).rejects.toThrow()
    const original = f.server.requests.find(request => request.method === 'DELETE')!
    expect(f.store.snapshot(old.id)?.status).toBe('deleting')
    f.reopen()
    if (mode === 'drop-after-commit') { await f.run(run.taskId); expect(f.store.snapshot(old.id)?.status).toBe('deleted') }
    else { await expect(f.run(run.taskId)).rejects.toThrow(); expect(f.store.snapshot(old.id)?.status).toBe('deleting'); expect(await f.server.exists(original.path)).toBe(true) }
    expect(f.server.requests.filter(request => request.method === 'DELETE' && request.path === original.path)).toHaveLength(1)
    expect(f.store.snapshotObjects(current.id).every(object => object.state === 'verified')).toBe(true)
  }, 20_000)

  it('rejects a real HTTP 207 response containing a failed resource before preparing any backup writes', async () => {
    const f = await fixture(); await f.write('payload.txt', 'bytes'); const plan = await f.plan()
    f.server.fault({ method: 'PROPFIND', mode: 'failed-resource' })
    expect(await f.service.previewBackup(plan.id)).toMatchObject({ success: false })
    expect(f.server.requests.every(request => request.method === 'PROPFIND')).toBe(true)
  })

  it.each(['malformed-multistatus', 'missing-resource-href'] as const)('rejects HTTP 207 %s even when the document has its closing multistatus tag', async mode => {
    const f = await fixture(); await f.write('payload.txt', 'bytes'); const plan = await f.plan()
    f.server.fault({ method: 'PROPFIND', mode })
    expect(await f.service.previewBackup(plan.id)).toMatchObject({ success: false })
    expect(f.server.requests.every(request => request.method === 'PROPFIND')).toBe(true)
  })

  it('rejects a truncated HTTP 207 directory instead of falsely deleting snapshot references while remote objects remain', async () => {
    const f = await fixture(); await f.write('payload.txt', 'retained until confirmed absent'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    const objects = f.store.snapshotObjects(snapshot.id), container = f.store.container(plan.id).id!
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [snapshot.id] })).preview, run = ok(await f.service.prune(preview.id))
    f.server.fault({ method: 'PROPFIND', path: container, mode: 'truncated-multistatus' })
    await expect(f.run(run.taskId)).rejects.toThrow()
    expect(f.store.snapshot(snapshot.id)?.status).not.toBe('deleted')
    expect(f.store.snapshotObjects(snapshot.id)).toHaveLength(objects.length)
    for (const object of objects) expect(await f.server.exists(object.remoteId!)).toBe(true)
    expect(f.server.requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
  }, 15_000)
})
