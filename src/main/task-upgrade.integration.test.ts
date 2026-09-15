import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'

const fixture = vi.hoisted(() => ({ directory: '', resume: vi.fn(), clear: vi.fn(async () => {}), adapter: {} as DriveAdapter }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adapters/registry', () => ({ getAdapter: () => fixture.adapter }))
vi.mock('./crypto', () => ({ decryptCredential: (value: string) => value }))
vi.mock('./archive', () => ({ cleanupTempDir: vi.fn(), createArchive: vi.fn(), extractArchive: vi.fn() }))
vi.mock('./runtime-services', () => ({ notifyTaskTerminal: vi.fn() }))
vi.mock('./task-resumable-download', () => ({ downloadTaskResumable: fixture.resume, clearTaskResumeCache: fixture.clear }))

import { getDb, getTaskById, initDatabase, insertAccount, insertTask } from './db'
import { downloadTransferFile, enqueueTask, getQueueStatus, retryTask } from './task-runner'
import { registerTaskExtension } from './task-extensions'
import { guardTaskAdapterMutations } from './task-operations'
import { fatal } from '../adapters/errors'
import { ResumableSourceChangedError } from './resumable-download'

const account: DriveAccount = { id: 'source', platform: 'webdav', nickname: 'test', loginType: 'password', credential: {}, status: 'active', createdAt: 1, updatedAt: 1 }
let sequence = 0
function task(status: 'pending' | 'running', type = 'download') {
  const id = `upgrade-${++sequence}`
  insertTask({ id, account_id: account.id, platform: 'webdav', task_type: type, title: id, payload: '{}', status,
    progress: 0, retry_count: 0, execution_token: status === 'running' ? id : null, error_message: null, created_at: 1, updated_at: 1, finished_at: null })
  return getTaskById(id)!
}
beforeAll(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-task-upgrade-'))
  vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
  insertAccount({ id: account.id, platform: account.platform, nickname: 'test', login_type: 'password', encrypted_credential: '{}',
    user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
})
beforeEach(() => {
  vi.clearAllMocks()
  fixture.adapter = { listFiles: vi.fn(), download: vi.fn(), getDownloadUrl: vi.fn(), delete: vi.fn(async () => {}) } as unknown as DriveAdapter
})
afterAll(() => {
  getDb().close()
  const checked = path.resolve(fixture.directory)
  if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('panlite-task-upgrade-')) throw new Error('Unexpected cleanup path')
  fs.rmSync(checked, { recursive: true, force: true })
})

it('does not fall back or overwrite an existing file when persistent source validation fails', async () => {
  const output = path.join(fixture.directory, 'kept.bin'); fs.writeFileSync(output, 'original')
  fixture.resume.mockRejectedValueOnce(new ResumableSourceChangedError())
  await expect(downloadTransferFile({ task: task('running'), account, adapter: fixture.adapter, fileId: 'file', fileSize: 64 * 1024 ** 2,
    localPath: output, overwrite: true, onProgress: () => {} })).rejects.toBeInstanceOf(ResumableSourceChangedError)
  expect(fixture.adapter.download).not.toHaveBeenCalled()
  expect(fs.readFileSync(output, 'utf8')).toBe('original')
})

it('keeps an old target if a fallback adapter creates truncated bytes and returns failure', async () => {
  const output = path.join(fixture.directory, 'failed.bin'); fs.writeFileSync(output, 'original')
  fixture.adapter.download = vi.fn(async (_account, _id, folder, options) => {
    const localPath = path.join(folder, options!.fileName!); fs.writeFileSync(localPath, 'bad')
    return { success: false, localPath, error: 'truncated' }
  })
  await expect(downloadTransferFile({ task: task('running'), account, adapter: fixture.adapter, fileId: 'file', fileSize: 8,
    localPath: output, overwrite: true, onProgress: () => {} })).rejects.toThrow('下载未完成')
  expect(fs.readFileSync(output, 'utf8')).toBe('original')
  expect(fs.readdirSync(fixture.directory).filter(name => name.startsWith('.panlite-download-'))).toEqual([])
})

it('publishes verified full fallback bytes but refuses a competing target without overwrite', async () => {
  const output = path.join(fixture.directory, 'race.bin')
  fixture.adapter.download = vi.fn(async (_account, _id, folder, options) => {
    const localPath = path.join(folder, options!.fileName!); fs.writeFileSync(localPath, 'download')
    fs.writeFileSync(output, 'racing writer')
    return { success: true, localPath }
  })
  await expect(downloadTransferFile({ task: task('running'), account, adapter: fixture.adapter, fileId: 'file', fileSize: 8,
    localPath: output, onProgress: () => {} })).rejects.toThrow()
  expect(fs.readFileSync(output, 'utf8')).toBe('racing writer')
  await downloadTransferFile({ task: task('running'), account, adapter: fixture.adapter, fileId: 'file', fileSize: 8,
    localPath: output, overwrite: true, onProgress: () => {} })
  expect(fs.readFileSync(output, 'utf8')).toBe('download')
})

it('routes a registered plan through the existing queue, progress fence and durable operation journal', async () => {
  let attempt = 0
  const adapter = guardTaskAdapterMutations(fixture.adapter)
  const unregister = registerTaskExtension('planned_transfer', async context => {
    attempt++
    context.assertActive(); context.progress(25)
    await context.operation('fixture write', 'exact-file', async () => { await adapter.delete(account, ['exact-file']); return { confirmed: true } })
    if (attempt === 1) throw fatal('fixture later failure')
    return { summary: 'resumed' }
  })
  try {
    const row = task('pending', 'planned_transfer'); enqueueTask(row.id)
    await vi.waitFor(() => expect(getTaskById(row.id)?.status).toBe('failed'))
    expect(getTaskById(row.id)?.progress).toBe(25)
    expect(retryTask(row.id)).toBe(true)
    await vi.waitFor(() => expect(getTaskById(row.id)?.status).toBe('success'))
    await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running)).toBe(true))
    expect(fixture.adapter.delete).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT status FROM task_operations WHERE task_id=?').get(row.id)).toEqual({ status: 'succeeded' })
  } finally { unregister() }
})
