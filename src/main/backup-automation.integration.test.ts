import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { FileItem } from '../shared/types'
import { createFileBackupsClient } from '../shared/file-backup-client'
import { createAutomationRulesClient } from '../shared/automation-rules-client'

const fixture = vi.hoisted(() => ({ directory: '', adapter: {} as DriveAdapter }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adapters/registry', () => ({ getAdapter: () => fixture.adapter }))
vi.mock('./crypto', () => ({ decryptCredential: (value: string) => value }))
vi.mock('./archive', () => ({ cleanupTempDir: vi.fn(), createArchive: vi.fn(), extractArchive: vi.fn() }))
vi.mock('./runtime-services', () => ({ notifyTaskTerminal: vi.fn() }))

import { getDb, getTaskById, initDatabase, insertAccount, getSupportedDatabaseMigrations } from './db'
import { disposeFileBackups, getFileBackupService, recoverFileBackupJobs } from './file-backup-runtime'
import { disposeTransferPlans } from './transfer-plan-runtime'
import { disposeAutomationRules, getAutomationRuleService } from './automation-rule-runtime'
import { getQueueStatus } from './task-runner'
import { registerFileBackupsIpcHandlers } from './ipc/file-backups'
import { registerAutomationRulesIpcHandlers } from './ipc/automation-rules'

const memory = new Map<string, { file: FileItem; bytes?: Buffer }>()
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const invoke = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('Unregistered channel')
  return handler({}, ...structuredClone(args))
}
const backups = createFileBackupsClient(invoke), rules = createAutomationRulesClient(invoke)
const expected = Buffer.from('真实队列 / 版本内容 / SHA256\n')
let sequence = 0, writes = 0, reads = 0, planId: string, ruleId: string, snapshotId: string, taskId: string, runId: string
function add(parentId: string, name: string, bytes?: Buffer): FileItem {
  const file: FileItem = { id: `object-${++sequence}`, parentId, name, isDir: !bytes, size: bytes?.length ?? 0,
    accountId: 'backup', platform: 'webdav', createdAt: 1, updatedAt: 1 }
  memory.set(file.id, { file, bytes }); return file
}
async function idle(): Promise<void> { await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running)).toBe(true), { timeout: 5000 }) }
beforeAll(async () => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-backup-rules-'))
  fs.mkdirSync(path.join(fixture.directory, 'source', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(fixture.directory, 'source', '文件.txt'), expected)
  vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
  insertAccount({ id: 'backup', platform: 'webdav', nickname: 'test', login_type: 'password', encrypted_credential: '{}',
    user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
  const adapter: Partial<DriveAdapter> = {
    async listFiles(account, parentId) { if (account.id !== 'backup') throw new Error('Wrong fixture account'); return { parentId, hasMore: false, files: [...memory.values()].filter(item => item.file.parentId === parentId).map(item => structuredClone(item.file)) } },
    async mkdir(_account, parentId, name) { writes++; return add(parentId, name) },
    async upload(_account, source, parentId, options) { writes++; const file = add(parentId, options?.fileName ?? path.basename(source), fs.readFileSync(source)); return { success: true, fileId: file.id, fileName: file.name, size: file.size } },
    async delete(_account, ids) { writes++; for (const id of ids) memory.delete(id) },
    async getDownloadSource(_account, fileId) { return { url: `https://isolated.invalid/${fileId}`, fetch: async () => { reads++; return new Response(new Uint8Array(memory.get(fileId)!.bytes!)) } } },
    async download(_account, fileId, directory, options) { reads++; const localPath = path.join(directory, options!.fileName!); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(localPath, memory.get(fileId)!.bytes!); return { success: true, localPath } },
  }
  fixture.adapter = adapter as DriveAdapter
  const registrar = { handle(channel: string, listener: (...args: never[]) => unknown) { handlers.set(channel, listener as (...args: unknown[]) => unknown) } }
  registerFileBackupsIpcHandlers(registrar, getFileBackupService())
  registerAutomationRulesIpcHandlers(registrar, getAutomationRuleService())
  await recoverFileBackupJobs()
})
afterAll(async () => {
  await idle(); disposeAutomationRules(); disposeFileBackups(); disposeTransferPlans(); getDb().close()
  const checked = path.resolve(fixture.directory)
  if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('panlite-backup-rules-')) throw new Error('Unexpected cleanup path')
  fs.rmSync(checked, { recursive: true, force: true })
})

it('migrates the profile and submits a backup rule through IPC into the original queue and journal', async () => {
  expect(getSupportedDatabaseMigrations()).toEqual(expect.arrayContaining(['013_add_versioned_file_backups', '015_add_automation_rules']))
  const saved = await backups.savePlan({ name: '项目版本', sourcePath: path.join(fixture.directory, 'source'), target: { accountId: 'backup', rootId: '0', rootPath: '/' }, exclude: [], keepLast: 3, keepDays: 30 })
  if (!saved.success) throw new Error(saved.error)
  planId = saved.plan.id
  const actions = await rules.listActions(); expect(actions.success && actions.actions[0].planId).toBe(planId)
  const created = await rules.saveRule({ name: '手动备份', enabled: true, action: { kind: 'backup', planId, planVersion: 1 }, trigger: { kind: 'manual' } })
  if (!created.success) throw new Error(created.error)
  ruleId = created.rule.id
  const dryRun = await rules.dryRun(ruleId); expect(dryRun.success && dryRun.preview.executable).toBe(true); expect(writes).toBe(0)
  const started = await rules.runNow({ id: ruleId, expectedVersion: 1 })
  if (!started.success) throw new Error(started.error)
  runId = started.run.id
  await getAutomationRuleService().waitForIdle()
  taskId = getAutomationRuleService().store.run(runId)!.taskId!
  expect(taskId).toBeTruthy()
  await vi.waitFor(() => expect(getTaskById(taskId)?.status).toBe('success'), { timeout: 5000 })
  await idle(); getAutomationRuleService().reconcile()
  expect(JSON.parse(getTaskById(taskId)!.payload)._automation).toEqual({ ruleId, runId })
  expect(getAutomationRuleService().store.run(runId)?.status).toBe('success')
  expect((getDb().prepare("SELECT count(*) n FROM task_operations WHERE task_id=? AND status='succeeded'").get(taskId) as { n: number }).n).toBeGreaterThanOrEqual(3)
  const versions = await backups.listSnapshots({ planId }); if (!versions.success) throw new Error(versions.error)
  snapshotId = versions.snapshots[0].id; expect(versions.snapshots[0].status).toBe('ready')
})

it('restores verified bytes and records a subsequent unchanged rule without another upload', async () => {
  const targetPath = path.join(fixture.directory, 'restored')
  const preview = await backups.previewRestore({ snapshotId, targetPath })
  if (!preview.success) throw new Error(preview.error)
  const restored = await backups.executeRestore(preview.preview.id); if (!restored.success) throw new Error(restored.error)
  await vi.waitFor(() => expect(getTaskById(restored.taskId)?.status).toBe('success'), { timeout: 5000 }); await idle()
  expect(createHash('sha256').update(fs.readFileSync(path.join(targetPath, '文件.txt'))).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
  expect(fs.statSync(path.join(targetPath, 'empty')).isDirectory()).toBe(true)
  const beforeWrites = writes, beforeReads = reads
  const started = await rules.runNow({ id: ruleId, expectedVersion: 1 }); if (!started.success) throw new Error(started.error)
  await getAutomationRuleService().waitForIdle()
  expect(getAutomationRuleService().store.run(started.run.id)?.status).toBe('success')
  expect(getAutomationRuleService().store.run(started.run.id)?.taskId).toBeUndefined()
  expect(writes).toBe(beforeWrites); expect(reads).toBeGreaterThan(beforeReads)
})

it('recovers an interrupted dispatch from real task provenance without duplicate submission', async () => {
  const current = getAutomationRuleService()
  current.store.patchRun(runId, { status: 'dispatching', taskId: undefined })
  const beforeTasks = getDb().prepare('SELECT count(*) n FROM tasks').get()
  disposeAutomationRules()
  getAutomationRuleService().recover()
  expect(getAutomationRuleService().store.run(runId)).toMatchObject({ status: 'success', taskId })
  expect(getDb().prepare('SELECT count(*) n FROM tasks').get()).toEqual(beforeTasks)
})
