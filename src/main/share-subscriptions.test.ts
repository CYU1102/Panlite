import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'
import type { DbTask } from './db'
import type { DriveAdapter } from '../adapters/base'
import type { SharedDirectoryEntry, ShareSubscriptionInput } from '../shared/subscription-types'
import type { TaskExtensionContext } from './task-extensions'

const database = vi.hoisted(() => ({ value: undefined as unknown as Database.Database }))
vi.mock('./db', () => ({ getDb: () => database.value, getAccountById: vi.fn(), getAllTasks: vi.fn(), getSetting: vi.fn(), invalidateFilesCacheParents: vi.fn() }))
vi.mock('./crypto', () => ({ decryptCredential: (value: string) => value }))
vi.mock('../adapters/registry', () => ({ getAdapter: vi.fn() }))
vi.mock('./task-runner', () => ({ createAndEnqueueTask: vi.fn(), pauseTask: vi.fn(), resumeTask: vi.fn(), cancelTask: vi.fn(), retryTask: vi.fn() }))
import { SubscriptionStore } from './subscription-store'
import { createShareSubscriptionScheduler, type ShareSubscriptionScheduler, type SubscriptionDependencies } from './share-subscriptions'
import { runTaskOperation } from './task-operations'

const account: DriveAccount = { id: 'account', platform: 'quark', nickname: 'Fixture', loginType: 'cookie', credential: { cookies: 'fixture' }, status: 'active', createdAt: 1, updatedAt: 1 }
const input: ShareSubscriptionInput = { accountId: account.id, platform: 'quark', url: 'https://pan.quark.cn/s/fixture', title: 'Series', targetDirId: 'target', targetDirPath: '/Series', scope: 'recursive' }
const file = (fileId: string, name = `${fileId}.mkv`, size = 10): SharedDirectoryEntry => ({ fileId, name, isDir: false, size })
const folder = (fileId: string, name = fileId): SharedDirectoryEntry => ({ fileId, name, isDir: true })
const events = { onSynced: vi.fn(), onFailed: vi.fn() }
let store: SubscriptionStore
let scheduler: ShareSubscriptionScheduler
let deps: SubscriptionDependencies
let tasks: DbTask[]
let tree: Record<string, SharedDirectoryEntry[]>
let adapter: DriveAdapter
const list = vi.fn(); const save = vi.fn(); const mkdir = vi.fn(); const targetList = vi.fn()
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

function status(task: DbTask, value: string) {
  task.status = value
  database.value.prepare('UPDATE tasks SET status=?,execution_token=? WHERE id=?').run(value, task.execution_token, task.id)
}
function context(task = tasks[tasks.length - 1]): TaskExtensionContext {
  task.execution_token = `attempt-${Math.random()}`
  status(task, 'running')
  const snapshot = { ...task }
  return { task: snapshot, signal: new AbortController().signal,
    assertActive: () => { if (task.status !== 'running' || task.execution_token !== snapshot.execution_token) throw new Error('paused or superseded') },
    operation: (kind, item, execute) => runTaskOperation(snapshot, kind, item, execute), progress: vi.fn(), log: vi.fn() }
}
async function baseline() {
  const config = await scheduler.save(input)
  await scheduler.runNow(config.id)
  return store.get(config.id)!
}

beforeEach(() => {
  vi.clearAllMocks(); tasks = []; tree = { '0': [folder('Season')], Season: [file('old')] }
  database.value = new Database(':memory:')
  database.value.pragma('foreign_keys=ON')
  database.value.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,execution_token TEXT);
    CREATE TABLE task_operations(task_id TEXT,operation_key TEXT,execution_token TEXT,status TEXT,result_json TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(task_id,operation_key));`)
  store = new SubscriptionStore(database.value, () => Date.now())
  list.mockImplementation(async (_account, _input, options) => ({ complete: true, entries: tree[options.parentId] || [] }))
  save.mockResolvedValue({ success: true, savedCount: 1 })
  mkdir.mockImplementation(async (_account, parent, name) => ({ id: `${parent}/${name}`, name, isDir: true }))
  targetList.mockResolvedValue({ files: [], hasMore: false })
  adapter = { listSharedDirectory: list, saveSharedFiles: save, listFiles: targetList, mkdir } as unknown as DriveAdapter
  deps = { store, getAccount: () => account, getAdapter: () => adapter, getTasks: () => tasks,
    enqueue: vi.fn((accountId, platform, type, title, payload) => {
      const id = `task-${tasks.length}`
      tasks.push({ id, account_id: accountId, platform, task_type: type, title, payload: JSON.stringify(payload), status: 'pending', progress: 0,
        retry_count: 0, error_message: null, execution_token: null, created_at: 1, updated_at: 1, finished_at: null })
      database.value.prepare('INSERT INTO tasks VALUES(?,?,NULL)').run(id, 'pending')
      return id
    }),
    taskAction: vi.fn((action, id) => { const task = tasks.find(item => item.id === id)!; status(task, action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'pending'); return true }),
    request: vi.fn(async (_id, execute, signal) => { signal?.throwIfAborted(); return execute() }), intervalMinutes: () => 5, clock: () => Date.now(), invalidate: vi.fn() }
  scheduler = createShareSubscriptionScheduler(events, deps)
})
afterEach(() => { scheduler.stop(); database.value.close(); vi.useRealTimers() })

describe('recursive subscriptions and durable execution', () => {
  it('builds a complete first baseline, including existing child directories, without transferring history', async () => {
    const config = await baseline()
    expect(config.baselineComplete).toBe(true)
    expect(store.observations(config.id).map(entry => entry.fileId).sort()).toEqual(['Season', 'old'])
    expect(deps.enqueue).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
    expect(deps.request).toHaveBeenCalledTimes(2)
  })
  it('saves new files in separate directories of the same share using distinct real journal keys', async () => {
    tree = { '0': [folder('A'), folder('B')], A: [], B: [] }
    const config = await baseline()
    tree.A = [file('a', 'episode.mkv')]; tree.B = [file('b', 'episode.mkv')]
    await scheduler.runNow(config.id)
    expect(store.observations(config.id)).toHaveLength(2)
    await scheduler.execute(context())
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.map(call => [call[1].fileIds, call[2], call[3].sourceParentId])).toEqual([
      [['a'], 'target/A', 'A'], [['b'], 'target/B', 'B'],
    ])
    const operations = database.value.prepare('SELECT operation_key FROM task_operations').all()
    expect(new Set(operations.map(row => (row as { operation_key: string }).operation_key)).size).toBe(4)
    expect(store.observations(config.id)).toHaveLength(4)
    expect(events.onSynced).toHaveBeenCalledWith(expect.objectContaining({ savedCount: 2 }))
  })
  it('optionally transfers existing matching files, preserves paths, and excludes disallowed extensions', async () => {
    tree.Season = [file('a', 'ep1.mkv'), file('b', 'advert.mkv'), file('c', 'notes.txt')]
    const config = await scheduler.save({ ...input, initialMode: 'save_existing', extensions: ['.mkv'], excludeKeywords: ['advert'] })
    await scheduler.runNow(config.id); await scheduler.execute(context())
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][1].fileIds).toEqual(['a'])
    expect(store.get(config.id)?.baselineComplete).toBe(true)
  })
  it('does not commit an incomplete scan and automatically retries transient failures', async () => {
    vi.useFakeTimers()
    const config = await baseline()
    tree.Season.push(file('new'))
    list.mockImplementationOnce(async () => { throw new Error('network timeout') })
    scheduler.start(); await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(store.get(config.id)?.status).toBe('active')
    expect(store.get(config.id)?.lastError).toBe('network timeout')
    expect(store.observations(config.id)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(store.observations(config.id)).toHaveLength(2)
  })
  it('never establishes a first baseline after a failing child page', async () => {
    const config = await scheduler.save(input)
    list.mockImplementation(async (_a, _i, options) => { if (options.parentId === 'Season') throw new Error('page 2 failed'); return { complete: true, entries: tree['0'] } })
    await scheduler.runNow(config.id)
    expect(store.get(config.id)?.baselineComplete).toBe(false); expect(store.observations(config.id)).toEqual([])
    expect(deps.enqueue).not.toHaveBeenCalled()
  })
  it('coalesces manual and timer checks while a directory request is pending', async () => {
    vi.useFakeTimers()
    const config = await scheduler.save(input)
    const pending = deferred<{ complete: true; entries: SharedDirectoryEntry[] }>()
    list.mockReturnValueOnce(pending.promise)
    scheduler.start(); await vi.advanceTimersByTimeAsync(0)
    const first = scheduler.runNow(config.id); const second = scheduler.runNow(config.id)
    expect(first).toBe(second)
    pending.resolve({ complete: true, entries: [] }); await first
    expect(list).toHaveBeenCalledTimes(1)
  })
  it.each(['pause', 'edit', 'delete'])('ignores an old scan after %s', async change => {
    const config = await baseline()
    const pending = deferred<{ complete: true; entries: SharedDirectoryEntry[] }>()
    list.mockReturnValueOnce(pending.promise)
    const checking = scheduler.runNow(config.id); await Promise.resolve(); await Promise.resolve()
    if (change === 'pause') scheduler.toggle(config.id, false)
    if (change === 'edit') await scheduler.save({ ...input, id: config.id, expectedVersion: config.configVersion, targetDirId: 'another' })
    if (change === 'delete') scheduler.remove(config.id)
    pending.resolve({ complete: true, entries: [file('new')] }); await checking
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(store.observations(config.id).some(entry => entry.fileId === 'new')).toBe(false)
  })
  it('records late save evidence after pause without committing the baseline, then resumes without another save', async () => {
    const config = await baseline(); tree.Season.push(file('new')); await scheduler.runNow(config.id)
    const pending = deferred<{ success: boolean; savedCount: number }>()
    save.mockReturnValueOnce(pending.promise)
    const running = scheduler.execute(context())
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    scheduler.toggle(config.id, false)
    pending.resolve({ success: true, savedCount: 1 })
    await expect(running).rejects.toThrow()
    expect(store.observations(config.id).map(entry => entry.fileId)).not.toContain('new')
    scheduler.toggle(config.id, true)
    await scheduler.execute(context())
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.observations(config.id).map(entry => entry.fileId)).toContain('new')
  })
  it('does not advance a new target configuration when an old save succeeds late', async () => {
    const config = await baseline(); tree.Season.push(file('new')); await scheduler.runNow(config.id)
    const pending = deferred<{ success: boolean; savedCount: number }>(); save.mockReturnValueOnce(pending.promise)
    const running = scheduler.execute(context()); await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await scheduler.save({ ...input, id: config.id, expectedVersion: config.configVersion, targetDirId: 'changed' })
    pending.resolve({ success: true, savedCount: 1 }); await expect(running).rejects.toThrow()
    expect(store.get(config.id)).toMatchObject({ configVersion: 2, targetDirId: 'changed', baselineComplete: false })
    expect(store.observations(config.id)).toEqual([])
  })
  it('reuses a pending task after scheduler restart and repairs a crash between task insert and run attachment', async () => {
    const config = await baseline(); tree.Season.push(file('new')); await scheduler.runNow(config.id)
    const run = store.activeRun(config.id, config.configVersion)!; run.taskId = undefined; store.updateRun(run)
    scheduler.stop(); scheduler = createShareSubscriptionScheduler(events, { ...deps, store: new SubscriptionStore(database.value) })
    await scheduler.runNow(config.id)
    expect(deps.enqueue).toHaveBeenCalledTimes(1); expect(store.getRun(run.id)?.taskId).toBe(tasks[0].id)
  })
  it('does not resend an ambiguous save when retrying the same run', async () => {
    const config = await baseline(); tree.Season.push(file('new')); await scheduler.runNow(config.id)
    save.mockRejectedValueOnce(new Error('response lost'))
    await expect(scheduler.execute(context())).rejects.toThrow('response lost')
    await expect(scheduler.execute(context())).rejects.toThrow(/结果待核对/)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('propagates schedule deferral before the next mutation while retaining proven receipts for resume', async () => {
    const config = await baseline(); tree.Season.push(file('one'), file('two')); await scheduler.runNow(config.id)
    const running = context()
    const operation = running.operation
    const deferred = Object.assign(new Error('waiting for next transfer window'), { code: 'TASK_SCHEDULE_DEFERRED' })
    running.operation = async (kind, item, execute) => {
      if (kind === '订阅转存' && save.mock.calls.length === 1) throw deferred
      return operation(kind, item, execute)
    }
    await expect(scheduler.execute(running)).rejects.toBe(deferred)
    const run = store.activeRun(config.id, config.configVersion)!
    expect(run.work.map(work => Boolean(work.done))).toEqual([true, false])
    expect(store.get(config.id)?.lastError).toBe('')
    expect(store.observations(config.id).map(entry => entry.fileId)).not.toContain('one')
    status(tasks[0], 'pending')
    await scheduler.execute(context())
    expect(save).toHaveBeenCalledTimes(2)
    expect(store.observations(config.id).map(entry => entry.fileId)).toEqual(expect.arrayContaining(['one', 'two']))
  })
  it('does not resave a disappeared ID when it returns and detects proven same-ID size changes', async () => {
    const config = await scheduler.save({ ...input, detectChanges: true }); await scheduler.runNow(config.id)
    tree.Season = []; await scheduler.runNow(config.id)
    tree.Season = [file('old')]; await scheduler.runNow(config.id); expect(deps.enqueue).not.toHaveBeenCalled()
    tree.Season = [file('old', 'renamed.mkv', 11)]; await scheduler.runNow(config.id)
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
  })
  it('validates account ownership, recursive platform capability and configuration version', async () => {
    deps.getAccount = () => ({ ...account, platform: 'baidu' }); scheduler = createShareSubscriptionScheduler(events, deps)
    await expect(scheduler.save({ ...input, platform: 'baidu', url: 'https://pan.baidu.com/s/fixture' })).rejects.toThrow(/不支持递归/)
    deps.getAccount = () => account; scheduler = createShareSubscriptionScheduler(events, deps)
    await expect(scheduler.save({ ...input, url: 'https://evil.invalid/s/fixture' })).rejects.toThrow(/不匹配/)
    const config = await scheduler.save(input)
    await expect(scheduler.save({ ...input, id: config.id, expectedVersion: 0 })).rejects.toThrow(/已更新/)
  })
})
