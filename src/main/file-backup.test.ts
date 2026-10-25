import Database from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, TaskStatus } from '../shared/types'
import type { FileBackupPlan, FileBackupResult, FileBackupSnapshot } from '../shared/file-backup'
import type { DbTask } from './db'
import type { TaskExtensionContext } from './task-extensions'
import { FileBackupStore, initializeFileBackupSchema } from './file-backup-store'
import { FileBackupService, type FileBackupDependencies } from './file-backup-service'
import { executeFileBackupTask, executeFileRestoreTask, executeFileBackupPruneTask } from './file-backup-executor'
import { runTaskOperation } from './task-operations'

const shared = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }))
vi.mock('./db', () => ({ getDb: () => shared.db }))
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function ok<T extends object>(result: FileBackupResult<T>): T { if (!result.success) throw new Error(result.error); return result }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-file-backup-test-')), source = path.join(root, 'source'), temporary = path.join(root, 'temporary'), filename = path.join(root, 'db.sqlite')
  fs.mkdirSync(source); fs.mkdirSync(temporary)
  let db = new Database(filename); shared.db = db
  const initialize = (): void => {
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); initializeFileBackupSchema(db)
    db.exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT,execution_token TEXT,payload TEXT,type TEXT);
      CREATE TABLE IF NOT EXISTS task_operations(task_id TEXT,operation_key TEXT,execution_token TEXT,status TEXT,result_json TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(task_id,operation_key));`)
  }
  initialize()
  let clock = 1_000_000, store = new FileBackupStore(db, () => ++clock)
  const account: DriveAccount = { id: 'webdav-account', platform: 'webdav', nickname: '备份试点', loginType: 'password', credential: { password: 'never-export-this' }, status: 'active', createdAt: 0, updatedAt: 0 }
  const remote = new Map<string, { file: FileItem; bytes?: Buffer }>()
  let uploadCount = 0, deleteCount = 0, lostUpload = false, lostDelete = false, failUpload = false, corruptUpload = false
  let progressHook: ((summary: string, context: TaskExtensionContext) => void) | undefined
  let uploadHook: (() => void) | undefined
  const remoteFile = (id: string, parentId: string, name: string, isDir: boolean, size: number): FileItem => ({ id, parentId, name, isDir, size, accountId: account.id, platform: 'webdav', createdAt: clock, updatedAt: clock })
  const adapter: DriveAdapter = {
    checkLogin: async () => true, getUserInfo: async () => ({ nickname: account.nickname }), searchFiles: async () => [], rename: async () => {}, move: async () => {},
    listFiles: vi.fn(async (_account, parentId) => ({ parentId, hasMore: false, files: [...remote.values()].filter(entry => entry.file.parentId === parentId).map(entry => ({ ...entry.file })) })),
    mkdir: vi.fn(async (_account, parentId, name) => {
      const id = parentId + '/' + name
      if (remote.has(id)) throw new Error('already exists')
      const file = remoteFile(id, parentId, name, true, 0); remote.set(id, { file }); return { ...file }
    }),
    upload: vi.fn(async (_account, localPath, parentId, settings) => {
      uploadCount++
      if (failUpload) return { success: false, error: 'failed' }
      const name = settings?.fileName ?? path.basename(localPath), id = parentId + '/' + name
      if (remote.has(id)) throw new Error('immutable name collision')
      const bytes = corruptUpload ? Buffer.from('corrupt') : fs.readFileSync(localPath)
      remote.set(id, { file: remoteFile(id, parentId, name, false, bytes.length), bytes })
      uploadHook?.()
      if (lostUpload) { lostUpload = false; throw new Error('response lost after commit') }
      return { success: true, fileId: id, fileSize: bytes.length }
    }),
    download: vi.fn(async (_account, fileId, directory, settings) => {
      const item = remote.get(fileId)
      if (!item?.bytes) throw new Error('missing remote bytes')
      const localPath = path.join(directory, settings?.fileName ?? item.file.name)
      fs.writeFileSync(localPath, item.bytes, { flag: 'wx' })
      return { success: true, localPath, fileName: path.basename(localPath), fileSize: item.bytes.length }
    }),
    getDownloadSource: async (_account, fileId) => ({ url: 'https://fixture.invalid/object', fetch: async () => {
      const entry = remote.get(fileId)
      return entry?.bytes ? new Response(entry.bytes as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 })
    } }),
    delete: vi.fn(async (_account, ids) => { deleteCount++; for (const id of ids) remote.delete(id); if (lostDelete) { lostDelete = false; throw new Error('delete response lost') } }),
  }
  const dependencies: FileBackupDependencies = {
    getAccount: id => id === account.id ? account : undefined, getAdapter: () => adapter,
    getTaskStatus: id => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: TaskStatus } | undefined)?.status,
    findTaskByJob: job => {
      const type = job.kind === 'backup' ? 'file_backup' : job.kind === 'restore' ? 'file_restore' : 'file_backup_prune'
      const row = db.prepare("SELECT id,status FROM tasks WHERE type=? AND json_extract(payload,'$.jobId')=? AND json_extract(payload,'$.planId')=? AND json_extract(payload,'$.previewId')=? AND json_extract(payload,'$.snapshotId') IS ?")
        .get(type, job.id, job.planId, job.previewId, job.snapshotId ?? null) as { id: string; status: TaskStatus } | undefined
      return row ? { taskId: row.id, status: row.status } : undefined
    },
    enqueueTask: input => { const id = randomUUID(); db.prepare("INSERT INTO tasks(id,status,payload,type) VALUES(?,'pending',?,?)").run(id, JSON.stringify(input.payload), input.type); return id },
  }
  let service = new FileBackupService(store, dependencies)
  cleanups.push(() => { service.dispose(); db.close(); shared.db = undefined; fs.rmSync(root, { recursive: true, force: true }) })
  const f = {
    root, source, temporary, remote, account, adapter, dependencies,
    get service() { return service }, get store() { return store }, get db() { return db }, get uploadCount() { return uploadCount }, get deleteCount() { return deleteCount },
    set lostUpload(value: boolean) { lostUpload = value }, set lostDelete(value: boolean) { lostDelete = value }, set failUpload(value: boolean) { failUpload = value }, set corruptUpload(value: boolean) { corruptUpload = value },
    set progressHook(value: typeof progressHook) { progressHook = value }, set uploadHook(value: typeof uploadHook) { uploadHook = value },
    write(relative: string, data: string): void { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) },
    async plan(): Promise<FileBackupPlan> { return ok(await service.savePlan({ name: '项目文件备份', sourcePath: source, target: { accountId: account.id, rootId: 'root', rootPath: '/' }, exclude: [], keepLast: 1, keepDays: 0 })).plan },
    async prepare(planId: string): Promise<{ snapshot: FileBackupSnapshot; taskId?: string; unchanged: boolean }> {
      const preview = ok(await service.previewBackup(planId)).preview
      expect(preview.executable).toBe(true)
      return ok(await service.executeBackup({ planId, previewId: preview.id }))
    },
    async run(taskId: string): Promise<void> {
      const token = randomUUID(), controller = new AbortController()
      db.prepare("UPDATE tasks SET status='running',execution_token=? WHERE id=?").run(token, taskId)
      const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as { payload: string; type: string }
      const task: DbTask = { id: taskId, account_id: account.id, platform: 'webdav', task_type: row.type, title: '', payload: row.payload, status: 'running', progress: 0,
        retry_count: 0, error_message: null, execution_token: token, created_at: 0, updated_at: 0, finished_at: null }
      const context: TaskExtensionContext = {
        task, signal: controller.signal,
        assertActive: () => {
          const current = db.prepare('SELECT status,execution_token token FROM tasks WHERE id=?').get(taskId) as { status: string; token: string } | undefined
          if (current?.status !== 'running' || current.token !== token) { controller.abort(new Error('Task paused or superseded')); throw controller.signal.reason }
        },
        operation: (kind, item, execute) => runTaskOperation(task, kind, item, execute),
        progress: (_percent, summary) => { if (summary) progressHook?.(summary, context) }, log: () => {},
      }
      try {
        const executor = row.type === 'file_backup' ? executeFileBackupTask : row.type === 'file_restore' ? executeFileRestoreTask : executeFileBackupPruneTask
        await executor(context, { service, tempRoot: temporary })
        db.prepare("UPDATE tasks SET status='success' WHERE id=? AND status='running'").run(taskId)
      } catch (error) { db.prepare("UPDATE tasks SET status=? WHERE id=? AND status='running'").run((error as { code?: string })?.code === 'TASK_SCHEDULE_DEFERRED' ? 'pending' : 'failed', taskId); throw error }
    },
    async backup(planId: string): Promise<FileBackupSnapshot> { const result = await f.prepare(planId); if (result.taskId) await f.run(result.taskId); return store.snapshot(result.snapshot.id)! },
    async restore(snapshotId: string, destination: string, overwrite = false): Promise<void> {
      const preview = ok(await service.previewRestore({ snapshotId, targetPath: destination, overwrite })).preview
      expect(preview.executable).toBe(true)
      await f.run(ok(await service.executeRestore(preview.id)).taskId)
    },
    reopen(): void { service.dispose(); db.close(); db = new Database(filename); shared.db = db; initialize(); store = new FileBackupStore(db, () => ++clock); service = new FileBackupService(store, dependencies) },
  }
  return f
}

describe('versioned file backup, restore and safe retention', () => {
  it('backs up three content versions and restores every SHA256 including empty directories; source deletion leaves history', async () => {
    const f = fixture(); f.write('nested/note.txt', 'version one'); fs.mkdirSync(path.join(f.source, 'empty'))
    const plan = await f.plan(), versions: FileBackupSnapshot[] = []
    for (const contents of ['version one', 'version two', 'version three']) { f.write('nested/note.txt', contents); versions.push(await f.backup(plan.id)) }
    fs.unlinkSync(path.join(f.source, 'nested/note.txt'))
    const deletionSnapshot = await f.backup(plan.id)
    expect(deletionSnapshot).toMatchObject({ status: 'ready', fileCount: 0 })
    for (const [index, contents] of ['version one', 'version two', 'version three'].entries()) {
      const destination = path.join(f.root, `restore-${index}`)
      await f.restore(versions[index].id, destination)
      expect(sha(fs.readFileSync(path.join(destination, 'nested/note.txt')))).toBe(sha(contents))
      expect(fs.statSync(path.join(destination, 'empty')).isDirectory()).toBe(true)
    }
    expect(f.store.snapshots(plan.id)).toHaveLength(4)
    expect(f.store.snapshotObjects(versions[0].id).every(object => object.state === 'verified')).toBe(true)
  })

  it('performs zero uploads for unchanged content and deduplicates identical file bytes within a version', async () => {
    const f = fixture(); f.write('one.txt', 'same bytes'); f.write('two.txt', 'same bytes')
    const plan = await f.plan(), first = await f.backup(plan.id), uploads = f.uploadCount
    expect(uploads).toBe(2) // one immutable content object plus one version manifest
    const unchanged = await f.prepare(plan.id)
    expect(unchanged).toMatchObject({ unchanged: true, snapshot: { id: first.id, status: 'ready' } }); expect(unchanged.taskId).toBeUndefined()
    expect(f.uploadCount).toBe(uploads); expect(f.store.snapshots(plan.id)).toHaveLength(1)
  })

  it('previews without mutations and rejects source changes between preview and submission', async () => {
    const f = fixture(); f.write('file.txt', 'old'); const plan = await f.plan()
    const preview = ok(await f.service.previewBackup(plan.id)).preview
    expect(f.uploadCount).toBe(0); expect(f.adapter.mkdir).not.toHaveBeenCalled(); expect(f.deleteCount).toBe(0)
    f.write('file.txt', 'new')
    expect(await f.service.executeBackup({ planId: plan.id, previewId: preview.id })).toMatchObject({ success: false, code: 'STALE_PREVIEW' })
    expect(f.store.snapshots(plan.id)).toEqual([])
  })

  it('rejects local mutations during upload and never calls the incomplete snapshot ready', async () => {
    const f = fixture(); f.write('file.txt', 'first'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.uploadHook = () => { f.write('file.txt', 'changed while uploading'); f.uploadHook = undefined }
    await expect(f.run(run.taskId!)).rejects.toThrow('备份期间源目录变化')
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('failed')
    expect(await f.service.previewRestore({ snapshotId: run.snapshot.id, targetPath: path.join(f.root, 'bad-restore') })).toMatchObject({ success: false, code: 'SNAPSHOT_NOT_READY' })
  })

  it('recovers a paused execution from SQLite without reuploading verified content', async () => {
    const f = fixture(); f.write('a.txt', 'a'); f.write('b.txt', 'b'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.progressHook = (summary, context) => {
      if (summary === '已确认：a.txt') { f.progressHook = undefined; f.db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(context.task.id) }
    }
    await expect(f.run(run.taskId!)).rejects.toThrow('Task paused')
    expect(f.uploadCount).toBe(1)
    f.reopen(); await f.run(run.taskId!)
    expect(f.uploadCount).toBe(3) // a, b and the manifest, with no repeated upload of a
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it('reconciles an upload response lost after commit by reading SHA256, never by resending the mutation', async () => {
    const f = fixture(); f.write('file.txt', 'valuable bytes'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.lostUpload = true
    await expect(f.run(run.taskId!)).rejects.toThrow('待核对')
    expect(f.uploadCount).toBe(1); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('uncertain')
    expect(f.db.prepare("SELECT COUNT(*) count FROM task_operations WHERE status='started'").get()).toEqual({ count: 1 })
    f.reopen(); await f.run(run.taskId!)
    expect(f.uploadCount).toBe(2); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it('does not resend a failed/unknown upload when no matching remote object can be confirmed', async () => {
    const f = fixture(); f.write('file.txt', 'bytes'); const plan = await f.plan(), run = await f.prepare(plan.id)
    f.failUpload = true
    await expect(f.run(run.taskId!)).rejects.toThrow('待核对'); expect(f.uploadCount).toBe(1)
    f.failUpload = false
    await expect(f.run(run.taskId!)).rejects.toThrow('待核对'); expect(f.uploadCount).toBe(1)
    expect(f.store.snapshot(run.snapshot.id)?.status).not.toBe('ready')
  })

  it('rejects successful upload responses whose returned bytes fail full-content verification', async () => {
    const f = fixture(); f.write('file.txt', 'authentic'); const plan = await f.plan(), run = await f.prepare(plan.id); f.corruptUpload = true
    await expect(f.run(run.taskId!)).rejects.toThrow('内容校验失败')
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('failed')
  })

  it('keeps shared objects referenced by surviving versions and deletes only the precise previewed exclusive objects', async () => {
    const f = fixture(); f.write('stable.txt', 'shared'); f.write('changing.txt', 'v1'); const plan = await f.plan(), old = await f.backup(plan.id)
    f.write('changing.txt', 'v2'); const latest = await f.backup(plan.id)
    const sharedObject = f.store.entries(old.id).find(entry => entry.relativePath === 'stable.txt')!.objectId!
    expect(f.store.references(sharedObject)).toHaveLength(2)
    const preview = ok(await f.service.retentionPreview({ planId: plan.id })).preview
    expect(preview.snapshotIds).toEqual([old.id])
    const detail = ok(await f.service.getRetentionPreview({ previewId: preview.id, pageSize: 200 }))
    expect(detail.objects.map(object => object.objectId)).not.toContain(sharedObject)
    expect(detail.objects).toHaveLength(2) // old unique contents and old manifest
    await f.run(ok(await f.service.prune(preview.id)).taskId)
    expect(f.store.snapshot(old.id)?.status).toBe('deleted'); expect(f.store.object(sharedObject)?.state).toBe('verified')
    const destination = path.join(f.root, 'surviving-restore'); await f.restore(latest.id, destination)
    expect(fs.readFileSync(path.join(destination, 'stable.txt'), 'utf8')).toBe('shared')
    expect(fs.readFileSync(path.join(destination, 'changing.txt'), 'utf8')).toBe('v2')
  })

  it('rejects a stale retention preview after new references are added', async () => {
    const f = fixture(); f.write('data.txt', 'v1'); const plan = await f.plan(), first = await f.backup(plan.id)
    f.write('data.txt', 'v2'); await f.backup(plan.id)
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [first.id] })).preview
    f.write('data.txt', 'v1'); await f.backup(plan.id)
    expect(await f.service.prune(preview.id)).toMatchObject({ success: false, code: 'STALE_PREVIEW' }); expect(f.deleteCount).toBe(0)
  })

  it('confirms an unknown deletion as absent on retry, without dispatching a second DELETE', async () => {
    const f = fixture(); f.write('data.txt', 'v1'); const plan = await f.plan(), first = await f.backup(plan.id)
    f.write('data.txt', 'v2'); await f.backup(plan.id)
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [first.id] })).preview
    const run = ok(await f.service.prune(preview.id)); f.lostDelete = true
    await expect(f.run(run.taskId)).rejects.toThrow('待核对')
    expect(f.deleteCount).toBe(1)
    f.reopen(); await f.run(run.taskId)
    expect(f.deleteCount).toBe(2); expect(f.store.snapshot(first.id)?.status).toBe('deleted')
  })

  it('requires explicit overwrite preview and preserves changed local files rather than overwriting stale evidence', async () => {
    const f = fixture(); f.write('data.txt', 'backup bytes'); const plan = await f.plan(), snapshot = await f.backup(plan.id), destination = path.join(f.root, 'restore')
    fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'data.txt'), 'old local')
    expect(ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: destination })).preview.executable).toBe(false)
    const preview = ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: destination, overwrite: true })).preview
    expect(preview.overwriteCount).toBe(1)
    const run = ok(await f.service.executeRestore(preview.id)); fs.writeFileSync(path.join(destination, 'data.txt'), 'changed after preview')
    await expect(f.run(run.taskId)).rejects.toThrow('预演不一致')
    expect(fs.readFileSync(path.join(destination, 'data.txt'), 'utf8')).toBe('changed after preview')
    await f.restore(snapshot.id, destination, true)
    expect(fs.readFileSync(path.join(destination, 'data.txt'), 'utf8')).toBe('backup bytes')
  })

  it('never follows source or destination junctions and forbids restoring into the live source tree', async () => {
    const f = fixture(); f.write('data.txt', 'real'); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'untouched')
    await fsp.symlink(outside, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const plan = await f.plan(), blocked = ok(await f.service.previewBackup(plan.id)).preview
    expect(blocked.executable).toBe(false); expect(blocked.failures[0].error).toContain('链接')
    const updated = ok(await f.service.savePlan({ ...plan, expectedVersion: plan.version, exclude: ['linked/**'] })).plan
    const snapshot = await f.backup(updated.id)
    expect(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: path.join(f.source, 'restore') })).toMatchObject({ success: false })
    const linkedDestination = path.join(f.root, 'linked-destination'); await fsp.symlink(outside, linkedDestination, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: linkedDestination, overwrite: true })).toMatchObject({ success: false })
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('untouched')
  })

  it('rejects snapshot traversal paths and partial remote listings rather than publishing an unsafe restoration', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    f.db.prepare('UPDATE file_backup_entries SET data=? WHERE snapshot_id=? AND relative_path=?').run(JSON.stringify({ relativePath: '../escape', isDir: false, size: 4, sha256: sha('data') }), snapshot.id, 'data.txt')
    expect(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: path.join(f.root, 'restore') })).toMatchObject({ success: false })
    vi.mocked(f.adapter.listFiles).mockResolvedValueOnce({ parentId: 'root', files: [], hasMore: true })
    expect(await f.service.previewBackup(plan.id)).toMatchObject({ success: false, code: 'INCOMPLETE_LISTING' })
  })

  it('supports explicit removal of every version only through a warning-bearing exact prune preview', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    expect(await f.service.removePlan(plan.id)).toMatchObject({ success: false })
    const preview = ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [snapshot.id] })).preview
    expect(preview.warnings.join(' ')).toContain('最后一个可恢复版本')
    await f.run(ok(await f.service.prune(preview.id)).taskId)
    expect(await f.service.removePlan(plan.id)).toEqual({ success: true })
  })

  it('defers before a mkdir admission without inventing a dispatched write, then resumes normally', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), run = await f.prepare(plan.id)
    const deferred = Object.assign(new Error('window closed'), { code: 'TASK_SCHEDULE_DEFERRED' }); let requests = 0
    f.dependencies.request = async (_account, execute) => { if (++requests === 2) throw deferred; return execute() }
    await expect(f.run(run.taskId!)).rejects.toBe(deferred)
    expect(f.adapter.mkdir).not.toHaveBeenCalled(); expect(f.store.container(plan.id).state).toBe('pending')
    expect(f.store.jobs(plan.id)[0].status).toBe('running'); expect(f.store.jobItems(f.store.jobs(plan.id)[0].id)).toEqual([])
    f.dependencies.request = undefined
    await f.run(run.taskId!)
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it('passes scheduled download deferral through upload reconciliation without marking failure or resending', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), run = await f.prepare(plan.id)
    const deferred = Object.assign(new Error('window closed'), { code: 'TASK_SCHEDULE_DEFERRED' })
    vi.mocked(f.adapter.download!).mockRejectedValueOnce(deferred)
    await expect(f.run(run.taskId!)).rejects.toBe(deferred)
    expect(f.uploadCount).toBe(1); expect(f.store.snapshotObjects(run.snapshot.id)[0].state).toBe('dispatched')
    expect(f.store.snapshot(run.snapshot.id)?.status).toBe('running'); expect(f.store.jobs(plan.id)[0].status).toBe('running')
    expect(f.store.jobItems(f.store.jobs(plan.id)[0].id)).toEqual([])
    expect(f.db.prepare("SELECT COUNT(*) count FROM task_operations WHERE status='started'").get()).toEqual({ count: 1 })
    f.reopen(); await f.service.recoverInterruptedJobs(); await f.run(run.taskId!)
    expect(f.uploadCount).toBe(2); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it.each(['restore', 'prune'] as const)('passes %s verification deferral to the queue without failed or uncertain evidence', async kind => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    const submission = kind === 'restore'
      ? ok(await f.service.executeRestore(ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: path.join(f.root, 'restore') })).preview.id))
      : ok(await f.service.prune(ok(await f.service.retentionPreview({ planId: plan.id, snapshotIds: [snapshot.id] })).preview.id))
    const deferred = Object.assign(new Error('window closed'), { code: 'TASK_SCHEDULE_DEFERRED' })
    vi.mocked(f.adapter.download!).mockRejectedValueOnce(deferred)
    await expect(f.run(submission.taskId)).rejects.toBe(deferred)
    expect(f.store.job(submission.job.id)?.status).toBe('running'); expect(f.store.jobItems(submission.job.id)).toEqual([])
    expect(f.deleteCount).toBe(0)
    await f.run(submission.taskId)
    expect(f.store.job(submission.job.id)?.status).toBe('completed')
  })

  it('reconciles a lost mkdir response after reopening without repeating directory creation', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), run = await f.prepare(plan.id)
    const mkdir = vi.mocked(f.adapter.mkdir).getMockImplementation()!
    vi.mocked(f.adapter.mkdir).mockImplementationOnce(async (...args) => { await mkdir(...args); throw new Error('mkdir response lost') })
    await expect(f.run(run.taskId!)).rejects.toThrow('mkdir response lost')
    expect(f.store.container(plan.id).state).toBe('uncertain')
    f.reopen(); await f.run(run.taskId!)
    expect(f.adapter.mkdir).toHaveBeenCalledTimes(1); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it('refuses no-change success when a previously verified remote object was corrupted', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), snapshot = await f.backup(plan.id), uploads = f.uploadCount
    const preview = ok(await f.service.previewBackup(plan.id)).preview, object = f.store.snapshotObjects(snapshot.id).find(object => object.kind === 'data')!
    f.remote.get(object.remoteId!)!.bytes = Buffer.from('evil')
    expect(await f.service.executeBackup({ planId: plan.id, previewId: preview.id })).toMatchObject({ success: false, code: 'OBJECT_CORRUPT' })
    expect(f.store.snapshot(snapshot.id)?.status).toBe('damaged'); expect(f.uploadCount).toBe(uploads)
    expect(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: path.join(f.root, 'restore') })).toMatchObject({ success: false, code: 'SNAPSHOT_NOT_READY' })
  })

  it('does not replace a previewed local file with corrupted remote bytes', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    const destination = path.join(f.root, 'restore'); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'data.txt'), 'keep original')
    const preview = ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: destination, overwrite: true })).preview
    const job = ok(await f.service.executeRestore(preview.id)), object = f.store.snapshotObjects(snapshot.id).find(object => object.kind === 'data')!
    f.remote.get(object.remoteId!)!.bytes = Buffer.from('evil')
    await expect(f.run(job.taskId)).rejects.toMatchObject({ code: 'OBJECT_CORRUPT' })
    expect(fs.readFileSync(path.join(destination, 'data.txt'), 'utf8')).toBe('keep original')
    expect(f.store.snapshot(snapshot.id)?.status).toBe('damaged')
  })

  it('recovers queue binding after restart without enqueueing a duplicate task', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), run = await f.prepare(plan.id), job = f.store.jobs(plan.id)[0]
    f.store.patchJob(job.id, { taskId: undefined }); f.store.patchSnapshot(run.snapshot.id, { taskId: undefined })
    f.reopen()
    expect(await f.service.previewBackup(plan.id)).toMatchObject({ success: false, code: 'PLAN_BUSY' })
    await f.service.recoverInterruptedJobs()
    expect(f.store.job(job.id)).toMatchObject({ taskId: run.taskId, status: 'queued' }); expect(f.store.snapshot(run.snapshot.id)?.taskId).toBe(run.taskId)
    expect(f.db.prepare('SELECT COUNT(*) count FROM tasks').get()).toEqual({ count: 1 }); expect(f.uploadCount).toBe(0)
    await f.run(run.taskId!); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('ready')
  })

  it('marks an orphaned submission failed only after exact queue lookup and never infers ready from task success', async () => {
    const f = fixture(); f.write('data.txt', 'data'); const plan = await f.plan(), run = await f.prepare(plan.id), job = f.store.jobs(plan.id)[0]
    f.db.prepare("UPDATE tasks SET payload=json_set(payload,'$.planId','unrelated-plan') WHERE id=?").run(run.taskId)
    f.reopen(); await f.service.recoverInterruptedJobs()
    expect(f.store.job(job.id)?.status).toBe('failed'); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('failed')
    expect(f.uploadCount).toBe(0); expect(f.db.prepare('SELECT COUNT(*) count FROM tasks').get()).toEqual({ count: 1 })
    expect((await f.service.previewBackup(plan.id)).success).toBe(true)
    f.db.prepare("UPDATE tasks SET payload=json_set(payload,'$.planId',?),status='success' WHERE id=?").run(plan.id, run.taskId)
    f.store.patchJob(job.id, { status: 'queued' }); f.store.patchSnapshot(run.snapshot.id, { status: 'queued' })
    await f.service.recoverInterruptedJobs()
    expect(f.store.job(job.id)?.status).toBe('failed'); expect(f.store.snapshot(run.snapshot.id)?.status).toBe('failed')
  })

  it('restores a selected single file with only its necessary ancestors and frozen byte counts', async () => {
    const f = fixture(); f.write('nested/deep/selected.txt', 'restore only me'); f.write('nested/other.txt', 'not selected'); f.write('outside.txt', 'not selected')
    fs.mkdirSync(path.join(f.source, 'unselected-empty')); const plan = await f.plan(), snapshot = await f.backup(plan.id), destination = path.join(f.root, 'selected-file')
    const selection = ['nested/deep/selected.txt'], preview = ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: destination, relativePaths: selection })).preview
    selection.push('outside.txt') // Caller changes do not change the persisted scope.
    expect(preview).toMatchObject({ relativePaths: ['nested/deep/selected.txt'], fileCount: 1, directoryCount: 3, totalBytes: Buffer.byteLength('restore only me') })
    const detail = ok(await f.service.getRestorePreview({ previewId: preview.id, pageSize: 200 }))
    expect(detail.items.map(item => item.relativePath)).toEqual(['', 'nested', 'nested/deep', 'nested/deep/selected.txt'])
    const run = ok(await f.service.executeRestore(preview.id)); expect(run.job.totalItems).toBe(4); await f.run(run.taskId)
    expect(sha(fs.readFileSync(path.join(destination, 'nested/deep/selected.txt')))).toBe(sha('restore only me'))
    expect(fs.readdirSync(destination)).toEqual(['nested']); expect(fs.readdirSync(path.join(destination, 'nested'))).toEqual(['deep'])
  })

  it('restores every descendant of a selected directory across snapshot and restore-preview pages', async () => {
    const f = fixture(); for (let index = 0; index < 7; index++) f.write(`folder/sub/f${index}.txt`, `content ${index}`)
    f.write('outside.txt', 'must stay absent'); fs.mkdirSync(path.join(f.source, 'folder/empty'))
    const plan = await f.plan(), snapshot = await f.backup(plan.id), firstPage = ok(await f.service.getSnapshot({ snapshotId: snapshot.id, pageSize: 2, page: 1 }))
    expect(firstPage.entries.map(entry => entry.relativePath)).toEqual(['', 'folder']); expect(firstPage.total).toBeGreaterThan(2)
    const destination = path.join(f.root, 'selected-directory'), preview = ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath: destination, relativePaths: ['folder'] })).preview
    expect(preview).toMatchObject({ fileCount: 7, directoryCount: 4 })
    const paged = ok(await f.service.getRestorePreview({ previewId: preview.id, pageSize: 2, page: 2 }))
    expect(paged.items).toHaveLength(2); expect(paged.total).toBe(11)
    await f.run(ok(await f.service.executeRestore(preview.id)).taskId)
    for (let index = 0; index < 7; index++) expect(sha(fs.readFileSync(path.join(destination, `folder/sub/f${index}.txt`)))).toBe(sha(`content ${index}`))
    expect(fs.statSync(path.join(destination, 'folder/empty')).isDirectory()).toBe(true); expect(fs.existsSync(path.join(destination, 'outside.txt'))).toBe(false)
  }, 10_000)

  it('rejects empty, missing and traversing restore selections and refuses a persisted scope expansion', async () => {
    const f = fixture(); f.write('selected.txt', 'selected'); f.write('outside.txt', 'outside'); const plan = await f.plan(), snapshot = await f.backup(plan.id)
    const targetPath = path.join(f.root, 'selected')
    for (const relativePaths of [[], ['missing'], ['../outside'], ['/absolute'], ['C:/outside'], ['selected.txt/../outside'], ['selected.txt\\bad'], [null], 'selected.txt']) {
      expect(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath, relativePaths: relativePaths as string[] })).toMatchObject({ success: false })
    }
    const preview = ok(await f.service.previewRestore({ snapshotId: snapshot.id, targetPath, relativePaths: ['selected.txt'] })).preview
    const row = f.db.prepare('SELECT data FROM file_backup_previews WHERE id=?').get(preview.id) as { data: string }, document = JSON.parse(row.data)
    document.items.push({ ...f.store.entries(snapshot.id).find(entry => entry.relativePath === 'outside.txt'), action: 'create' })
    f.db.prepare('UPDATE file_backup_previews SET data=? WHERE id=?').run(JSON.stringify(document), preview.id)
    expect(await f.service.executeRestore(preview.id)).toMatchObject({ success: false, code: 'STALE_PREVIEW' })
    expect(fs.existsSync(targetPath)).toBe(false)
  })
})
