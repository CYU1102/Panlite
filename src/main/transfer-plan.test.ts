import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, TaskStatus } from '../shared/types'
import type { TransferPlan, TransferPlanResult, TransferPreview } from '../shared/transfer-plan'
import type { DbTask } from './db'
import type { TaskExtensionContext } from './task-extensions'
import { initializeTransferPlanSchema, TransferPlanStore } from './transfer-plan-store'
import { TransferPlanService } from './transfer-plan-service'
import { executeTransferPlanTask } from './transfer-plan-executor'
const state = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }))
vi.mock('./db', () => ({ getDb: () => state.db }))
import { runTaskOperation } from './task-operations'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function ok<T extends object>(result: TransferPlanResult<T>): T { if (result.success === false) throw new Error(`${result.code}: ${result.error}`); return result }
const md5 = (content: Buffer): string => createHash('md5').update(content).digest('hex')
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-plan-test-')), databasePath = path.join(directory, 'plan.sqlite')
  let db = new Database(databasePath)
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL')
  initializeTransferPlanSchema(db)
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,execution_token TEXT);
    CREATE TABLE task_operations(task_id TEXT NOT NULL,operation_key TEXT NOT NULL,execution_token TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(task_id,operation_key));`)
  state.db = db
  let store = new TransferPlanStore(db)
  const accounts = new Map<string, DriveAccount>(['a', 'b'].map(id => [id, { id, platform: 'pan123', nickname: id, loginType: 'token', credential: { accessToken: 'PRIVATE-CREDENTIAL' }, status: 'active', createdAt: 0, updatedAt: 0 }]))
  const remote = new Map<string, Map<string, FileItem>>([['a', new Map()], ['b', new Map()]])
  const bodies = new Map<string, Buffer>()
  const tasks = new Map<string, DbTask>()
  const downloads: string[] = [], uploads: string[] = [], mutations: string[] = [], copies: string[] = []
  const incomplete = new Set<string>(), failureDirectories = new Set<string>(), failDownloads = new Set<string>(), uncertainUploads = new Set<string>()
  let sequence = 0
  const add = (accountId: string, name: string, parentId = accountId === 'a' ? 'source' : 'target', options: { isDir?: boolean; content?: string; hash?: boolean; id?: string } = {}): FileItem => {
    const id = options.id ?? `${accountId}-${++sequence}`, body = Buffer.from(options.content ?? `body-${name}`)
    const file: FileItem = { id, parentId, name, isDir: !!options.isDir, size: options.isDir ? 0 : body.length, updatedAt: sequence, createdAt: 0,
      platform: 'pan123', accountId, raw: { ...(options.hash === false || options.isDir ? {} : { etag: md5(body) }), download_url: 'https://secret.invalid/?signature=PRIVATE-DIRECT-LINK' } }
    remote.get(accountId)!.set(id, file); bodies.set(id, body); return file
  }
  const adapter: DriveAdapter = {
    checkLogin: async () => true, getUserInfo: async () => ({ nickname: 'fixture' }), searchFiles: async () => [],
    listFiles: async (account, parentId) => {
      if (failureDirectories.has(`${account.id}:${parentId}`)) throw new Error('PRIVATE-CREDENTIAL connection failed')
      return { parentId, files: [...remote.get(account.id)!.values()].filter(file => file.parentId === parentId).map(file => structuredClone(file)), hasMore: incomplete.has(`${account.id}:${parentId}`) }
    },
    mkdir: async (account, parentId, name) => { mutations.push(`mkdir:${account.id}:${name}`); return add(account.id, name, parentId, { isDir: true }) },
    rename: async () => { throw new Error('Unexpected rename') }, move: async () => { throw new Error('Unexpected move') },
    delete: async (account, ids) => { mutations.push(`delete:${ids.join(',')}`); for (const id of ids) remote.get(account.id)!.delete(id) },
    download: async (_account, id, localDir, options) => {
      downloads.push(id)
      if (failDownloads.has(id)) throw new Error('network download failed')
      const localPath = path.join(localDir, options!.fileName!)
      fs.writeFileSync(localPath, bodies.get(id)!)
      return { success: true, localPath }
    },
    upload: async (account, localPath, parentId, options) => {
      const name = options!.fileName!
      uploads.push(name); mutations.push(`upload:${name}`)
      const file = add(account.id, name, parentId, { content: fs.readFileSync(localPath, 'utf8') })
      if (uncertainUploads.has(name)) throw new Error('response lost after upload committed')
      return { success: true, fileId: file.id, fileName: name, fileSize: file.size }
    },
    copy: async (account, ids, parentId) => {
      if (ids.length !== 1) throw new Error('A plan must copy one file per journal operation')
      const file = remote.get(account.id)!.get(ids[0])!
      copies.push(file.id); mutations.push(`copy:${file.id}`)
      add(account.id, file.name, parentId, { content: bodies.get(file.id)!.toString() })
    },
  }
  const deps = { getAccount: (id: string) => accounts.get(id), getAdapter: () => adapter,
    getTaskStatus: (id: string) => tasks.get(id)?.status as TaskStatus | undefined,
    enqueueTask: (input: { accountId: string; platform: string; type: string; title: string; payload: object }): string => {
      const id = randomUUID(), token = randomUUID()
      const task: DbTask = { id, account_id: input.accountId, platform: input.platform, task_type: input.type, title: input.title, payload: JSON.stringify(input.payload), status: 'pending',
        execution_token: token, retry_count: 0, error_message: null, progress: 0, created_at: 0, updated_at: 0, finished_at: null }
      tasks.set(id, task); db.prepare('INSERT INTO tasks(id,status,execution_token) VALUES(?,?,?)').run(id, 'pending', token); return id
    },
  }
  let service = new TransferPlanService(store, deps)
  cleanups.push(() => { service.dispose(); db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  async function plan(options: { sameAccount?: boolean; conflictPolicy?: 'overwrite' | 'rename' | 'skip'; exclude?: string[] } = {}): Promise<TransferPlan> {
    return ok(await service.savePlan({ name: '测试计划', source: { accountId: 'a', rootId: 'source', rootPath: '/source' }, target: { accountId: options.sameAccount ? 'a' : 'b', rootId: 'target', rootPath: '/target' },
      exclude: options.exclude ?? [], conflictPolicy: options.conflictPolicy ?? 'overwrite' })).plan
  }
  const context = (taskId: string, controller = new AbortController(), onProgress?: () => void): TaskExtensionContext => {
    const task = tasks.get(taskId)!
    task.status = 'running'; task.execution_token = randomUUID()
    db.prepare('UPDATE tasks SET status=?,execution_token=? WHERE id=?').run('running', task.execution_token, task.id)
    const assertActive = (): void => {
      controller.signal.throwIfAborted()
      const row = db.prepare('SELECT status,execution_token FROM tasks WHERE id=?').get(task.id) as { status: string; execution_token: string }
      if (row.status !== 'running' || row.execution_token !== task.execution_token) throw new Error('TASK_SUPERSEDED')
    }
    return { task: { ...task }, signal: controller.signal, assertActive, operation: (kind, item, execute) => runTaskOperation(task, kind, item, execute), progress: () => onProgress?.(), log: vi.fn() }
  }
  const execute = async (plan: TransferPlan, preview: TransferPreview) => {
    const queued = ok(await service.executePlan({ planId: plan.id, previewId: preview.id }))
    const result = await executeTransferPlanTask(context(queued.taskId), { service, tempRoot: directory })
    tasks.get(queued.taskId)!.status = result.partial ? 'partial_success' : 'success'
    return { ...queued, result }
  }
  return { directory, databasePath, accounts, remote, bodies, tasks, downloads, uploads, mutations, copies, incomplete, failureDirectories, failDownloads, uncertainUploads, adapter, add, plan, context, execute,
    get db() { return db }, get store() { return store }, get service() { return service },
    async preview(plan: TransferPlan): Promise<TransferPreview> { return ok(await service.previewPlan(plan.id)).preview },
    reopen() { service.dispose(); db.close(); db = new Database(databasePath); db.pragma('foreign_keys=ON'); initializeTransferPlanSchema(db); state.db = db; store = new TransferPlanStore(db); service = new TransferPlanService(store, deps) },
  }
}

describe('saved transfer plans and real SQLite operation-journal execution', () => {
  it('persists configurations, exclusions, preview versions and paginated evidence without credentials', async () => {
    const f = fixture(); f.add('a', 'a.txt'); f.add('a', 'ignore.tmp')
    const plan = await f.plan({ exclude: ['**/*.tmp'] }), preview = await f.preview(plan)
    expect(f.mutations).toHaveLength(0)
    expect(preview.summary).toMatchObject({ totalItems: 2, addCount: 1, skipCount: 1, transferBytes: 'body-a.txt'.length * 2 })
    f.reopen()
    expect(ok(await f.service.listPlans()).plans[0]).toMatchObject({ id: plan.id, version: 1, exclude: ['**/*.tmp'] })
    expect(ok(await f.service.getPreview({ previewId: preview.id, pageSize: 1, page: 2 })).items).toHaveLength(1)
    const exported = ok(await f.service.exportPlan({ planId: plan.id, previewId: preview.id })).json
    expect(exported).not.toMatch(/PRIVATE|credential|download_url/)
    expect(await f.service.savePlan({ ...plan, expectedVersion: 0 })).toMatchObject({ success: false })
  })
  it('requires an explicit decision for same-name same-size files without trusted hash evidence', async () => {
    const f = fixture(); f.add('a', 'same.txt', 'source', { content: 'abc', hash: false }); f.add('b', 'same.txt', 'target', { content: 'xyz', hash: false })
    const plan = await f.plan(), preview = await f.preview(plan)
    expect(preview).toMatchObject({ executable: false, summary: { reviewCount: 1, identicalCount: 0 } })
    expect(await f.service.executePlan({ planId: plan.id, previewId: preview.id })).toMatchObject({ success: false, code: 'REVIEW_REQUIRED' })
    const item = ok(await f.service.getPreview({ previewId: preview.id })).items[0]
    const resolved = ok(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: item.id, action: 'overwrite' }] })).preview
    expect(resolved.executable).toBe(true)
    await f.execute(plan, resolved)
    expect(f.uploads).toEqual(['same.txt'])
    expect(f.mutations[0]).toMatch(/^delete:/)
  })
  it('rejects a stale preview before enqueue and repeats the check after a queue delay', async () => {
    const f = fixture(), original = f.add('a', 'a.txt'), plan = await f.plan(), preview = await f.preview(plan)
    original.size++
    expect(await f.service.executePlan({ planId: plan.id, previewId: preview.id })).toMatchObject({ success: false, code: 'STALE_PREVIEW' })
    expect(f.tasks.size).toBe(0); expect(f.mutations).toHaveLength(0)
    original.size--
    const next = await f.preview(plan), queued = ok(await f.service.executePlan({ planId: plan.id, previewId: next.id }))
    f.add('b', 'unexpected.txt')
    await expect(executeTransferPlanTask(f.context(queued.taskId), { service: f.service, tempRoot: f.directory })).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(f.mutations).toHaveLength(0)
  })
  it('marks partial directory listings and read failures without claiming a complete executable preview', async () => {
    const f = fixture(); f.add('a', 'visible.txt'); f.incomplete.add('a:source')
    const plan = await f.plan(), first = await f.preview(plan)
    expect(first.complete).toBe(false); expect(first.executable).toBe(false); expect(first.failures[0].side).toBe('source')
    f.incomplete.clear(); f.failureDirectories.add('b:target')
    const second = await f.preview(plan)
    expect(second.complete).toBe(false); expect(JSON.stringify(second)).not.toContain('PRIVATE-CREDENTIAL')
    expect(f.mutations).toHaveLength(0)
  })
  it('detects same-account directory overlap by authoritative recursion despite false UI paths and exclusions', async () => {
    const f = fixture(); f.add('a', 'nested-target', 'source', { id: 'target', isDir: true })
    const plan = await f.plan({ sameAccount: true, exclude: ['nested-target'] })
    expect(await f.service.previewPlan(plan.id)).toMatchObject({ success: false, code: 'OVERLAPPING_DIRECTORIES' })
    expect(f.mutations).toHaveLength(0)
  })
  it('rejects same-account aliases of a source file so overwrite can never delete the source object', async () => {
    const f = fixture(), source = f.add('a', 'shared.txt', 'source', { hash: false }), list = f.adapter.listFiles
    f.adapter.listFiles = async (account, parentId) => parentId === 'target'
      ? { parentId, hasMore: false, files: [{ ...source, parentId }] } : list(account, parentId)
    const plan = await f.plan({ sameAccount: true })
    expect(await f.service.previewPlan(plan.id)).toMatchObject({ success: false, code: 'OVERLAPPING_DIRECTORIES' })
    expect(f.mutations).toHaveLength(0)
  })
  it('keeps relative structure and empty directories, and records real remote IDs per operation', async () => {
    const f = fixture(), folder = f.add('a', 'projects', 'source', { isDir: true }), empty = f.add('a', 'empty', folder.id, { isDir: true })
    f.add('a', 'readme.txt', folder.id); f.add('a', 'root.txt')
    const plan = await f.plan(), preview = await f.preview(plan), { run } = await f.execute(plan, preview)
    const results = f.store.results(run.id)
    expect(results.map(item => item.outputPath)).toEqual(['projects', 'projects/empty', 'projects/readme.txt', 'root.txt'])
    expect(results.every(item => item.status === 'success' && item.remoteId && f.remote.get('b')!.has(item.remoteId))).toBe(true)
    expect(f.downloads).not.toContain(empty.id)
    expect(f.db.prepare("SELECT count(*) n FROM task_operations WHERE status='succeeded'").get()).toEqual({ n: 4 })
    expect(ok(await f.service.getReport({ runId: run.id, pageSize: 2 })).total).toBe(4)
  })
  it('renames a conflicting directory and all descendants without deleting the target file', async () => {
    const f = fixture(), folder = f.add('a', 'docs', 'source', { isDir: true }); f.add('a', 'a.txt', folder.id); const existing = f.add('b', 'docs')
    const plan = await f.plan(), preview = await f.preview(plan), item = ok(await f.service.getPreview({ previewId: preview.id })).items[0]
    expect(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: item.id, action: 'overwrite' }] })).toMatchObject({ success: false })
    const resolved = ok(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: item.id, action: 'rename' }] })).preview
    const items = ok(await f.service.getPreview({ previewId: preview.id })).items
    expect(items.map(item => item.outputPath)).toEqual(['docs (迁移 1)', 'docs (迁移 1)/a.txt'])
    await f.execute(plan, resolved)
    expect(f.remote.get('b')!.has(existing.id)).toBe(true)
    expect(f.mutations.some(value => value.startsWith('delete:'))).toBe(false)
  })
  it('uses one journaled native-copy mutation per file for non-overlapping same-account folders', async () => {
    const f = fixture(), source = f.add('a', 'copy.txt'), plan = await f.plan({ sameAccount: true }), preview = await f.preview(plan)
    expect(preview.summary.transferBytes).toBe(0)
    await f.execute(plan, preview)
    expect(f.copies).toEqual([source.id]); expect(f.downloads).toHaveLength(0); expect(f.uploads).toHaveLength(0)
  })
  it('retains uncertain results and never repeats an upload whose response was lost', async () => {
    const f = fixture(); f.add('a', 'lost.txt'); f.uncertainUploads.add('lost.txt')
    const plan = await f.plan(), preview = await f.preview(plan), queued = await f.execute(plan, preview)
    expect(queued.result.partial).toBe(true)
    expect(f.store.getRun(queued.run.id)).toMatchObject({ uncertain: 1, status: 'partial' })
    expect(f.db.prepare('SELECT status FROM task_operations').get()).toEqual({ status: 'started' })
    await expect(executeTransferPlanTask(f.context(queued.taskId), { service: f.service, tempRoot: f.directory })).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(f.uploads).toEqual(['lost.txt'])
  })
  it('retries safe read failures while retaining successful entries across a database reopen', async () => {
    const f = fixture(), failed = f.add('a', 'b.txt'); f.add('a', 'a.txt'); f.failDownloads.add(failed.id)
    const plan = await f.plan(), preview = await f.preview(plan), queued = await f.execute(plan, preview)
    expect(f.store.getRun(queued.run.id)).toMatchObject({ succeeded: 1, failed: 1, status: 'partial' })
    f.failDownloads.clear(); f.reopen()
    await executeTransferPlanTask(f.context(queued.taskId), { service: f.service, tempRoot: f.directory })
    expect(f.uploads).toEqual(['a.txt', 'b.txt'])
    expect(f.store.getRun(queued.run.id)).toMatchObject({ succeeded: 2, failed: 0, status: 'completed' })
  })
  it('resumes after pause without repeating the completed remote operation', async () => {
    const f = fixture(); f.add('a', 'a.txt'); f.add('a', 'b.txt')
    const plan = await f.plan(), preview = await f.preview(plan), queued = ok(await f.service.executePlan({ planId: plan.id, previewId: preview.id }))
    const controller = new AbortController()
    const context = f.context(queued.taskId, controller, () => { if (f.uploads.length) controller.abort(new Error('pause')) })
    await expect(executeTransferPlanTask(context, { service: f.service, tempRoot: f.directory })).rejects.toThrow('pause')
    expect(f.store.results(queued.run.id).filter(item => item.status === 'success')).toHaveLength(1)
    await executeTransferPlanTask(f.context(queued.taskId), { service: f.service, tempRoot: f.directory })
    expect(f.uploads).toEqual(['a.txt', 'b.txt'])
  })
  it('prevents duplicate Execute clicks and editing/deleting a queued plan', async () => {
    const f = fixture(); f.add('a', 'a.txt')
    const plan = await f.plan(), preview = await f.preview(plan)
    const results = await Promise.all([f.service.executePlan({ planId: plan.id, previewId: preview.id }), f.service.executePlan({ planId: plan.id, previewId: preview.id })])
    expect(results.filter(result => result.success)).toHaveLength(1); expect(f.tasks.size).toBe(1)
    expect(await f.service.savePlan({ ...plan, expectedVersion: plan.version })).toMatchObject({ success: false, code: 'PLAN_BUSY' })
    expect(await f.service.removePlan(plan.id)).toMatchObject({ success: false, code: 'PLAN_BUSY' })
  })
  it('rebuilds descendant actions when changing a directory decision from skip to rename', async () => {
    const f = fixture(), sourceFolder = f.add('a', 'docs', 'source', { isDir: true }), targetFolder = f.add('b', 'docs', 'target', { isDir: true })
    f.add('a', 'same.txt', sourceFolder.id, { content: 'same' }); f.add('b', 'same.txt', targetFolder.id, { content: 'same' })
    const plan = await f.plan(), preview = await f.preview(plan), folder = ok(await f.service.getPreview({ previewId: preview.id })).items[0]
    ok(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: folder.id, action: 'skip' }] }))
    const renamed = ok(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: folder.id, action: 'rename' }] })).preview
    expect(ok(await f.service.getPreview({ previewId: preview.id })).items[1]).toMatchObject({ outputPath: 'docs (迁移 1)/same.txt', action: 'create' })
    await f.execute(plan, renamed)
    expect(f.uploads).toEqual(['same.txt'])
    expect(f.remote.get('b')!.has(targetFolder.id)).toBe(true)
  })
  it('keeps duplicate-name conflicts explicit and preserves every original target object', async () => {
    const f = fixture(); f.add('a', 'duplicate.txt'); f.add('b', 'duplicate.txt'); f.add('b', 'duplicate.txt', 'target', { content: 'other' })
    const plan = await f.plan(), preview = await f.preview(plan), item = ok(await f.service.getPreview({ previewId: preview.id })).items[0]
    expect(item.category).toBe('conflict')
    const resolved = ok(await f.service.resolvePreview({ previewId: preview.id, decisions: [{ itemId: item.id, action: 'rename' }] })).preview
    await f.execute(plan, resolved)
    expect([...f.remote.get('b')!.values()].filter(file => file.name === 'duplicate.txt')).toHaveLength(2)
    expect(f.uploads).toEqual(['duplicate (迁移 1).txt'])
  })
  it('never deletes the existing target when local content verification fails before overwrite', async () => {
    const f = fixture(), source = f.add('a', 'a.txt', 'source', { content: 'new!' }), target = f.add('b', 'a.txt', 'target', { content: 'old!' })
    f.bodies.set(source.id, Buffer.from('evil'))
    const plan = await f.plan(), preview = await f.preview(plan), queued = ok(await f.service.executePlan({ planId: plan.id, previewId: preview.id }))
    await expect(executeTransferPlanTask(f.context(queued.taskId), { service: f.service, tempRoot: f.directory })).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(f.mutations).toHaveLength(0); expect(f.remote.get('b')!.has(target.id)).toBe(true)
  })
  it('does not mark a placeholder or contradictory remote ID as a successful result', async () => {
    const f = fixture(); f.add('a', 'a.txt')
    const upload = f.adapter.upload!
    f.adapter.upload = async (...args) => ({ ...await upload(...args), fileId: 'unconfirmed-placeholder' })
    const plan = await f.plan(), preview = await f.preview(plan), { run } = await f.execute(plan, preview)
    expect(f.store.results(run.id)[0]).toMatchObject({ status: 'uncertain' })
    expect(f.store.results(run.id)[0].remoteId).toBeUndefined()
  })
  it('requires an explicit hasMore=false and cancels a preview when its service is disposed', async () => {
    const f = fixture(), plan = await f.plan(), original = f.adapter.listFiles
    f.adapter.listFiles = async (...args) => ({ ...await original(...args), hasMore: undefined as unknown as boolean })
    expect((await f.preview(plan)).complete).toBe(false)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    f.adapter.listFiles = async (...args) => { entered(); await wait; return original(...args) }
    const pending = f.service.previewPlan(plan.id)
    await ready; f.service.dispose(); release()
    expect(await pending).toMatchObject({ success: false })
    expect(f.store.getPlan(plan.id)?.status).not.toBe('ready')
    expect(f.mutations).toHaveLength(0)
  })
  it('recovers interrupted previews and taskless queued runs without enqueueing or remote reads', async () => {
    const f = fixture(); f.add('a', 'a.txt')
    const plan = await f.plan(), preview = await f.preview(plan)
    f.store.createRun(preview)
    const other = await f.plan(); f.store.beginPreview(other.id)
    f.reopen()
    const list = vi.spyOn(f.adapter, 'listFiles')
    expect(f.service.recoverInterruptedPreviews()).toEqual({ previews: 1, queues: 1 })
    expect(list).not.toHaveBeenCalled(); expect(f.tasks.size).toBe(0)
    expect(f.store.getPlan(plan.id)).toMatchObject({ status: 'draft' })
    expect(f.store.getPlan(other.id)).toMatchObject({ status: 'draft' })
    expect(f.store.listRuns(plan.id)[0]).toMatchObject({ status: 'failed' })
  })
  it('implements 1000-file repeated migration: zero unchanged uploads, then only ten changed uploads', async () => {
    const f = fixture(), source: FileItem[] = []
    for (let index = 0; index < 1000; index++) source.push(f.add('a', `${String(index).padStart(4, '0')}.txt`))
    const plan = await f.plan()
    const first = await f.preview(plan)
    expect(f.mutations).toHaveLength(0)
    const initial = await f.execute(plan, first)
    expect(f.uploads).toHaveLength(1000)
    expect(f.store.getRun(initial.run.id)).toMatchObject({ succeeded: 1000, status: 'completed' })
    const second = await f.preview(plan)
    expect(second.summary).toMatchObject({ identicalCount: 1000, skipCount: 1000, transferBytes: 0 })
    await f.execute(plan, second)
    expect(f.uploads).toHaveLength(1000)
    for (const file of source.slice(0, 10)) { const body = Buffer.from(`changed-${file.name}`); f.bodies.set(file.id, body); file.size = body.length; file.updatedAt++; file.raw!.etag = md5(body) }
    const third = await f.preview(plan)
    expect(third.summary).toMatchObject({ changedCount: 10, identicalCount: 990, skipCount: 990 })
    const changed = await f.execute(plan, third)
    expect(f.uploads).toHaveLength(1010)
    expect(f.store.getRun(changed.run.id)).toMatchObject({ succeeded: 10, skipped: 990, status: 'completed' })
  }, 120_000)
})
