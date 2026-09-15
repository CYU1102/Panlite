import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, TaskStatus } from '../shared/types'
import type { TransferPlanResult } from '../shared/transfer-plan'

const fixture = vi.hoisted(() => ({ directory: '', adapter: {} as DriveAdapter }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adapters/registry', () => ({ getAdapter: () => fixture.adapter }))
vi.mock('./crypto', () => ({ decryptCredential: (value: string) => value }))
vi.mock('./archive', () => ({ cleanupTempDir: vi.fn(), createArchive: vi.fn(), extractArchive: vi.fn() }))
vi.mock('./runtime-services', () => ({ notifyTaskTerminal: vi.fn() }))
vi.mock('./task-resumable-download', () => ({ downloadTaskResumable: vi.fn(), clearTaskResumeCache: vi.fn(async () => {}) }))

import { getDb, getTaskById, initDatabase, insertAccount, insertTask, setSetting } from './db'
import { cancelTask, createAndEnqueueTask, enqueueTask, getQueueStatus, pauseTask, refreshTaskScheduling, resumeTask } from './task-runner'
import { saveTaskSchedule, taskScheduleInfo } from './task-scheduling'
import { initializeTaskSchedulingSchema, readTaskSchedule } from './task-scheduling-store'
import { registerTaskExtension } from './task-extensions'
import { guardTaskAdapterMutations } from './task-operations'
import { executeTransferPlanTask } from './transfer-plan-executor'
import { TransferPlanService } from './transfer-plan-service'
import { TransferPlanStore } from './transfer-plan-store'

const account: DriveAccount = { id: 'scheduling-account', platform: 'quark', nickname: 'Scheduling fixture', loginType: 'cookie', credential: {}, status: 'active', createdAt: 1, updatedAt: 1 }
const registrations: Array<() => void> = [], releaseGates: Array<() => void> = [], services: TransferPlanService[] = []
let sequence = 0
function row(type: string, payload: object = {}) {
  const id = `schedule-${++sequence}`, now = Date.now()
  insertTask({ id, account_id: account.id, platform: account.platform, task_type: type, title: id, payload: JSON.stringify(payload), status: 'pending', progress: 0, retry_count: 0, execution_token: null, error_message: null, created_at: now, updated_at: now, finished_at: null })
  return getTaskById(id)!
}
function closedWindow(): string { const hour = new Date().getHours(); return `${String((hour + 2) % 24).padStart(2, '0')}:00-${String((hour + 3) % 24).padStart(2, '0')}:00` }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releaseGates.push(release); return { promise, release } }
async function settled(id: string, status: string) { await vi.waitFor(() => expect(getTaskById(id)?.status).toBe(status)); await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running)).toBe(true)) }
function success<T extends object>(result: TransferPlanResult<T>): T { if (result.success === false) throw new Error(result.error); return result }

beforeAll(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-task-scheduling-'))
  vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
  insertAccount({ id: account.id, platform: account.platform, nickname: account.nickname, login_type: account.loginType, encrypted_credential: '{}', user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
  insertAccount({ id: 'scheduling-target', platform: account.platform, nickname: 'Target fixture', login_type: account.loginType, encrypted_credential: '{}', user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
})
beforeEach(() => {
  setSetting('transferScheduledWindow', ''); setSetting('transferPauseAtWindowEnd', 'false')
  setSetting('transferTempDir', fixture.directory); setSetting('transferParallelFiles', '2')
  fixture.adapter = {
    rename: vi.fn(async () => {}), delete: vi.fn(async () => {}), listFiles: vi.fn(async (_account, parentId) => ({ parentId, files: [], hasMore: false })),
    download: vi.fn(async (_account, _id, folder, options) => { fs.mkdirSync(folder, { recursive: true }); const localPath = path.join(folder, options!.fileName!); fs.writeFileSync(localPath, 'data'); return { success: true, localPath } }),
  } as unknown as DriveAdapter
})
afterEach(async () => {
  for (const task of getDb().prepare("SELECT id FROM tasks WHERE status IN ('pending','running','paused')").all() as { id: string }[]) cancelTask(task.id)
  for (const release of releaseGates.splice(0)) release()
  refreshTaskScheduling()
  await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running && !queue.pending)).toBe(true))
  for (const unregister of registrations.splice(0)) unregister()
  for (const service of services.splice(0)) service.dispose()
})
afterAll(() => {
  getDb().close()
  const checked = path.resolve(fixture.directory)
  if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('panlite-task-scheduling-')) throw new Error('Unexpected cleanup directory')
  fs.rmSync(checked, { recursive: true, force: true })
})

it('keeps a night download pending without blocking an eligible rename on the same platform', async () => {
  setSetting('transferScheduledWindow', closedWindow())
  const download = row('download', { targetDirPath: path.join(fixture.directory, 'night-download'), files: [{ fileId: 'data', fileName: 'data.txt', fileSize: 4, isDir: false }] })
  const rename = row('rename', { items: [{ fileId: 'remote', newName: 'renamed.txt' }] })
  enqueueTask(download.id); enqueueTask(rename.id)
  await settled(rename.id, 'success')
  expect(getTaskById(download.id)).toMatchObject({ status: 'pending', retry_count: 0, execution_token: null })
  expect(fixture.adapter.download).not.toHaveBeenCalled(); expect(fixture.adapter.rename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: account.id }), 'remote', 'renamed.txt')
  expect(taskScheduleInfo(download).waitReason).toContain('等待传输时段')
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling()
  await settled(download.id, 'success')
  expect(fixture.adapter.download).toHaveBeenCalledTimes(1)
  expect(fs.readFileSync(path.join(fixture.directory, 'night-download', 'data.txt'), 'utf8')).toBe('data')
})

it('recomputes dynamic windows immediately while a manual pause remains paused until explicit resume', async () => {
  const task = row('download', { targetDirPath: fixture.directory, files: [] })
  saveTaskSchedule(task.id, { priority: 'normal', window: closedWindow(), notBefore: null }); enqueueTask(task.id)
  await new Promise(resolve => setImmediate(resolve))
  expect(pauseTask(task.id)).toBe(true)
  saveTaskSchedule(task.id, { priority: 'high', window: '', notBefore: null }); refreshTaskScheduling()
  await new Promise(resolve => setImmediate(resolve))
  expect(getTaskById(task.id)?.status).toBe('paused'); expect(fixture.adapter.download).not.toHaveBeenCalled()
  expect(resumeTask(task.id)).toBe(true); await settled(task.id, 'success')
  expect(getTaskById(task.id)?.retry_count).toBe(0)
})

it('persists priority and not-before scheduling across database reopen and orders eligible waiting work', async () => {
  const low = row('planned_transfer'), high = row('planned_transfer'), normal = row('planned_transfer'), order: string[] = []
  const future = Date.now() + 3_600_000
  saveTaskSchedule(low.id, { priority: 'low', window: null, notBefore: null })
  saveTaskSchedule(high.id, { priority: 'high', window: '', notBefore: future })
  const reopened = new Database(path.join(fixture.directory, 'panlite.db'))
  try { initializeTaskSchedulingSchema(reopened); expect(readTaskSchedule(reopened, high.id)).toEqual({ priority: 'high', window: '', notBefore: future }) } finally { reopened.close() }
  expect(taskScheduleInfo(high)).toMatchObject({ waitReason: '等待指定开始时间', nextEligibleAt: future })
  saveTaskSchedule(high.id, { priority: 'high', window: '', notBefore: null })
  registrations.push(registerTaskExtension('planned_transfer', async context => { order.push(context.task.id) }))
  enqueueTask(low.id); enqueueTask(normal.id); enqueueTask(high.id)
  await settled(low.id, 'success')
  expect(order).toEqual([high.id, normal.id, low.id])
})

it('commits a remote-operation receipt before deferring at window end and never replays the confirmed write', async () => {
  setSetting('transferPauseAtWindowEnd', 'true')
  const adapter = guardTaskAdapterMutations(fixture.adapter)
  registrations.push(registerTaskExtension('planned_transfer', async context => {
    await context.operation('first write', 'one', async () => {
      await adapter.delete(account, ['one'])
      setSetting('transferScheduledWindow', closedWindow())
      return { confirmed: 'one' }
    })
    await context.operation('second write', 'two', async () => { await adapter.delete(account, ['two']); return { confirmed: 'two' } })
  }))
  const task = row('planned_transfer'); enqueueTask(task.id)
  await vi.waitFor(() => expect(fixture.adapter.delete).toHaveBeenCalledTimes(1))
  await settled(task.id, 'pending')
  expect(getTaskById(task.id)).toMatchObject({ status: 'pending', retry_count: 0, execution_token: null })
  expect(getDb().prepare('SELECT status,result_json FROM task_operations WHERE task_id=?').all(task.id)).toEqual([{ status: 'succeeded', result_json: '{"confirmed":"one"}' }])
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await settled(task.id, 'success')
  expect(vi.mocked(fixture.adapter.delete).mock.calls.map(call => call[1])).toEqual([['one'], ['two']])
  expect(getDb().prepare('SELECT COUNT(*) count FROM task_operations WHERE task_id=? AND status=?').get(task.id, 'succeeded')).toEqual({ count: 2 })
})

it('finishes an in-flight write safely when manually paused, and scheduling changes do not undo the pause', async () => {
  const pending = gate(), adapter = guardTaskAdapterMutations(fixture.adapter)
  fixture.adapter.delete = vi.fn(async () => { await pending.promise })
  registrations.push(registerTaskExtension('planned_transfer', async context => {
    await context.operation('held write', 'one', async () => { await adapter.delete(account, ['one']); return { committed: true } })
    context.assertActive()
  }))
  const task = row('planned_transfer'); enqueueTask(task.id)
  await vi.waitFor(() => expect(fixture.adapter.delete).toHaveBeenCalledTimes(1))
  expect(pauseTask(task.id)).toBe(true)
  saveTaskSchedule(task.id, { priority: 'high', window: '', notBefore: null }); refreshTaskScheduling(); pending.release()
  await settled(task.id, 'paused')
  expect(getDb().prepare('SELECT status FROM task_operations WHERE task_id=?').get(task.id)).toEqual({ status: 'succeeded' })
  expect(resumeTask(task.id)).toBe(true); await settled(task.id, 'success')
  expect(fixture.adapter.delete).toHaveBeenCalledTimes(1)
})

it('finishes nested upload directory receipts as one admitted operation before waiting for the next file', async () => {
  setSetting('transferPauseAtWindowEnd', 'true')
  fixture.adapter.mkdir = vi.fn(async (_account, parentId, name) => {
    if (name === 'outer') setSetting('transferScheduledWindow', closedWindow())
    return { id: `dir-${name}`, parentId, name, isDir: true, size: 0, createdAt: 1, updatedAt: 1, accountId: account.id, platform: account.platform }
  })
  fixture.adapter.upload = vi.fn(async (_account, _file, _parent, options) => ({ success: true, fileId: `uploaded-${options?.fileName}` }))
  const firstPath = path.join(fixture.directory, 'nested-one.txt'), secondPath = path.join(fixture.directory, 'nested-two.txt')
  fs.writeFileSync(firstPath, 'data'); fs.writeFileSync(secondPath, 'data')
  const task = row('upload', { targetDirId: 'target', conflictPolicy: 'overwrite', files: [
    { localPath: firstPath, fileName: 'nested-one.txt', relativePath: 'outer/inner/nested-one.txt', fileSize: 4 },
    { localPath: secondPath, fileName: 'nested-two.txt', fileSize: 4 },
  ] })
  enqueueTask(task.id)
  await vi.waitFor(() => expect(fixture.adapter.mkdir).toHaveBeenCalled())
  await settled(task.id, 'pending')
  expect(fixture.adapter.upload).toHaveBeenCalledTimes(1)
  expect(getDb().prepare('SELECT status FROM task_operations WHERE task_id=?').all(task.id)).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'succeeded' }])
  expect(getTaskById(task.id)?.retry_count).toBe(0)
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await settled(task.id, 'success')
  expect(fixture.adapter.mkdir).toHaveBeenCalledTimes(2); expect(fixture.adapter.upload).toHaveBeenCalledTimes(2)
})

it('waits for all in-flight staged uploads to write their receipts before releasing the task worker', async () => {
  setSetting('transferPauseAtWindowEnd', 'true')
  const secondStarted = gate(), finishSecond = gate()
  fixture.adapter.upload = vi.fn(async (_account, _file, _parent, options) => {
    if (options?.fileName === 'parallel-one.txt') { await secondStarted.promise; setSetting('transferScheduledWindow', closedWindow()) }
    if (options?.fileName === 'parallel-two.txt') { secondStarted.release(); await finishSecond.promise }
    return { success: true, fileId: `uploaded-${options?.fileName}` }
  })
  const task = row('cloud_transfer', { sourceAccountId: account.id, targetAccountId: 'scheduling-target', targetDirId: 'target', conflictPolicy: 'overwrite',
    files: ['one', 'two', 'three', 'four'].map(name => ({ fileId: name, fileName: `parallel-${name}.txt`, fileSize: 4, isDir: false })),
  })
  enqueueTask(task.id)
  await vi.waitFor(() => expect(fixture.adapter.upload).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(getDb().prepare("SELECT COUNT(*) count FROM task_operations WHERE task_id=? AND status='succeeded'").get(task.id)).toEqual({ count: 1 }))
  expect(getTaskById(task.id)?.status).toBe('running')
  expect(getQueueStatus().quark.running).toBe(1)
  finishSecond.release(); await settled(task.id, 'pending')
  expect(getTaskById(task.id)?.retry_count).toBe(0)
  expect(getDb().prepare("SELECT COUNT(*) count FROM task_operations WHERE task_id=? AND status='succeeded'").get(task.id)).toEqual({ count: 2 })
  expect(getDb().prepare("SELECT COUNT(*) count FROM task_operations WHERE task_id=? AND status='started'").get(task.id)).toEqual({ count: 0 })
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await settled(task.id, 'success')
  expect(vi.mocked(fixture.adapter.upload!).mock.calls.map(call => call[3]?.fileName).sort()).toEqual(['parallel-four.txt', 'parallel-one.txt', 'parallel-three.txt', 'parallel-two.txt'])
})

it.each(['after-save', 'after-filter'] as const)('preserves successful transfer records and post-processing receipts when the window closes %s', async phase => {
  setSetting('transferPauseAtWindowEnd', 'true'); setSetting('adFilterEnabled', 'true'); setSetting('bannedKeywords', '广告')
  const sourceUrl = `https://fixture.invalid/share/schedule-${sequence + 1}`
  fixture.adapter.saveSharedFiles = vi.fn(async () => {
    if (phase === 'after-save') setSetting('transferScheduledWindow', closedWindow())
    return { platform: account.platform, accountId: account.id, sourceUrl, success: true, savedCount: 2, savedFileIds: ['new-ad', 'new-report'], savedFileNames: ['广告.txt', 'report.txt'] }
  })
  fixture.adapter.delete = vi.fn(async () => { if (phase === 'after-filter') setSetting('transferScheduledWindow', closedWindow()) })
  fixture.adapter.createShare = vi.fn(async (_account: DriveAccount, items: Array<{ fileId: string }>) => ({ id: `scheduled-share-${sequence}`, accountId: account.id, platform: account.platform, fileIds: items.map(item => item.fileId), shareUrl: 'https://fixture.invalid/created', createdAt: Date.now() }))
  const task = row('transfer', { links: [{ url: sourceUrl }], targetDirId: 'target', autoShare: true }); enqueueTask(task.id)
  await vi.waitFor(() => expect(fixture.adapter.saveSharedFiles).toHaveBeenCalledTimes(1)); await settled(task.id, 'pending')
  expect(getTaskById(task.id)?.retry_count).toBe(0)
  expect(fixture.adapter.delete).toHaveBeenCalledTimes(phase === 'after-save' ? 0 : 1)
  expect(fixture.adapter.createShare).not.toHaveBeenCalled()
  expect(getDb().prepare('SELECT status,saved_count FROM transfer_records WHERE source_url=?').all(sourceUrl)).toEqual([{ status: 'success', saved_count: 2 }])
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await settled(task.id, 'success')
  expect(fixture.adapter.saveSharedFiles).toHaveBeenCalledTimes(1); expect(fixture.adapter.delete).toHaveBeenCalledTimes(1); expect(fixture.adapter.createShare).toHaveBeenCalledTimes(1)
  expect(vi.mocked(fixture.adapter.createShare!).mock.calls[0][1].map(item => item.fileId)).toEqual(['new-report'])
  expect(getDb().prepare("SELECT COUNT(*) count FROM transfer_records WHERE source_url=? AND status='failed'").get(sourceUrl)).toEqual({ count: 0 })
})

it('preserves a real migration executor run at window end without converting unsent items to failures', async () => {
  setSetting('transferPauseAtWindowEnd', 'true')
  const source: FileItem[] = ['one.txt', 'two.txt'].map((name, index) => ({ id: `source-${index}`, name, parentId: 'source', isDir: false, size: 4, updatedAt: 1, createdAt: 1, accountId: account.id, platform: account.platform }))
  const target: FileItem[] = []
  fixture.adapter.listFiles = vi.fn(async (_account, parentId) => ({ parentId, hasMore: false, files: structuredClone(parentId === 'source' ? source : target) }))
  fixture.adapter.copy = vi.fn(async (_account, ids, parentId) => { const file = source.find(file => file.id === ids[0])!; target.push({ ...file, id: `target-${ids[0]}`, parentId }); if (target.length === 1) setSetting('transferScheduledWindow', closedWindow()) })
  const service = new TransferPlanService(new TransferPlanStore(getDb()), {
    getAccount: id => id === account.id ? account : undefined, getAdapter: () => fixture.adapter,
    getTaskStatus: id => getTaskById(id)?.status as TaskStatus | undefined,
    enqueueTask: input => createAndEnqueueTask(input.accountId, input.platform, input.type, input.title, input.payload),
  }); services.push(service)
  registrations.push(registerTaskExtension('planned_transfer', context => executeTransferPlanTask(context, { service, tempRoot: fixture.directory })))
  const plan = success(await service.savePlan({ name: 'Scheduling migration', source: { accountId: account.id, rootId: 'source', rootPath: '/source' }, target: { accountId: account.id, rootId: 'target', rootPath: '/target' }, exclude: [], conflictPolicy: 'overwrite' })).plan
  const preview = success(await service.previewPlan(plan.id)).preview
  const execution = success(await service.executePlan({ planId: plan.id, previewId: preview.id }))
  await vi.waitFor(() => expect(fixture.adapter.copy).toHaveBeenCalledTimes(1))
  await settled(execution.taskId, 'pending')
  expect(getTaskById(execution.taskId)?.retry_count).toBe(0)
  expect(service.store.results(execution.run.id).map(item => item.status)).toEqual(['success'])
  expect(getDb().prepare('SELECT status FROM task_operations WHERE task_id=?').all(execution.taskId)).toEqual([{ status: 'succeeded' }])
  setSetting('transferScheduledWindow', ''); refreshTaskScheduling(); await settled(execution.taskId, 'success')
  expect(vi.mocked(fixture.adapter.copy!).mock.calls.map(call => call[1])).toEqual([['source-0'], ['source-1']])
  expect(service.store.getRun(execution.run.id)?.status).toBe('completed')
  expect(service.store.results(execution.run.id).every(item => item.status === 'success')).toBe(true)
})
