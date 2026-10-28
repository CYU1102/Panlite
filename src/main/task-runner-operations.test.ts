import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount, FileItem, ShareInfo, ShareTaskPayload, TransferResult } from '../shared/types'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-runner-operations-'))
process.env.PANLITE_TEST_USER_DATA = userData
const mocks = vi.hoisted(() => ({ adapter: {} as DriveAdapter }))
vi.mock('electron', () => ({ app: { getPath: () => process.env.PANLITE_TEST_USER_DATA }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adapters/registry', () => ({ getAdapter: () => mocks.adapter }))
vi.mock('./crypto', () => ({
  encryptCredential: (value: string) => `protected:${Buffer.from(value).toString('base64')}`,
  decryptCredential: (value: string) => value.startsWith('protected:') ? Buffer.from(value.slice(10), 'base64').toString('utf8') : value,
}))
vi.mock('./archive', () => ({ cleanupTempDir: vi.fn(), createArchive: vi.fn(), extractArchive: vi.fn() }))
vi.mock('./runtime-services', () => ({ notifyTaskTerminal: vi.fn() }))

import { getDb, getTaskById, initDatabase, insertAccount, insertTask, setSetting, listShareLinks, deleteShareLink, deleteTaskById } from './db'
import { enqueueTask, getQueueStatus, pauseTask, resumeTask, retryTask, cancelTask } from './task-runner'
import { taskOperationKey } from './task-operations'
import { IPC_CHANNELS, SETTINGS_KEYS } from '../shared/constants'
import { registerTasksIpcHandlers } from './ipc/tasks'
import { registerArchivesIpcHandlers } from './ipc/archives'
import { wrapTrustedIpcHandler, type TrustedIpcHandler } from './ipc-security'
import type { IpcMainInvokeEvent } from 'electron'
import { createArchive, extractArchive } from './archive'

let sequence = 0
let remote: FileItem[] = []

function task(taskType: string, payload: Record<string, unknown>, platform: 'quark' | 'baidu' = 'quark'): string {
  const id = `operation-${++sequence}`
  insertTask({ id, account_id: platform === 'baidu' ? 'baidu-account' : 'account', platform, task_type: taskType, title: id,
    payload: JSON.stringify(payload), status: 'pending', progress: 0, retry_count: 3,
    execution_token: null, error_message: null, created_at: Date.now(), updated_at: Date.now(), finished_at: null })
  return id
}

function uploadTask(conflictPolicy = 'rename'): string {
  return task('upload', { targetDirId: 'target', conflictPolicy,
    files: [{ localPath: 'test-file.txt', fileName: 'test-file.txt', fileSize: 42 }] })
}

function remoteFile(id: string, name: string, details: Partial<FileItem> = {}): FileItem {
  return { id, name, parentId: 'target', isDir: false, size: 42,
    createdAt: 0, updatedAt: 0, accountId: 'account', platform: 'quark', ...details }
}

function baiduFile(fsId: string, filePath: string, name: string): FileItem {
  return remoteFile(filePath, name, { path: filePath, raw: { fs_id: fsId }, platform: 'baidu', accountId: 'baidu-account' })
}

function transferTask(
  saved: Pick<TransferResult, 'savedFileIds' | 'savedFileNames' | 'savedFilePaths'>,
  platform: 'quark' | 'baidu' = 'quark',
  targetDirId = 'target',
): string {
  mocks.adapter.saveSharedFiles = vi.fn(async () => ({ success: true, platform,
    accountId: platform === 'baidu' ? 'baidu-account' : 'account', sourceUrl: 'https://mock.invalid/share',
    savedCount: saved.savedFileIds?.length, ...saved }))
  mocks.adapter.createShare = vi.fn(async (account: DriveAccount, items: ShareTaskPayload['items']) => ({ id: `auto-share-${++sequence}`,
    platform: account.platform, accountId: account.id, fileIds: items.map(item => item.fileId),
    shareUrl: 'https://mock.invalid/created-share', createdAt: Date.now() }))
  return task('transfer', { links: [{ url: 'https://mock.invalid/share' }], targetDirId, autoShare: true }, platform)
}

function expectSharedFiles(fileIds: string[]): void {
  expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
  expect(vi.mocked(mocks.adapter.createShare!).mock.calls[0][1].map(item => item.fileId)).toEqual(fileIds)
}

async function terminal(id: string, status: string): Promise<void> {
  await vi.waitFor(() => expect(getTaskById(id)?.status).toBe(status))
  await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running && !queue.pending)).toBe(true))
}

beforeAll(() => {
  initDatabase()
  insertAccount({ id: 'account', platform: 'quark', nickname: 'Mock', login_type: 'cookie', encrypted_credential: '{}',
    user_agent: null, status: 'active', bind_machine: 0, created_at: Date.now(), updated_at: Date.now(), last_check_at: null })
  insertAccount({ id: 'baidu-account', platform: 'baidu', nickname: 'Mock Baidu', login_type: 'cookie', encrypted_credential: '{}',
    user_agent: null, status: 'active', bind_machine: 0, created_at: Date.now(), updated_at: Date.now(), last_check_at: null })
})

beforeEach(() => {
  remote = []
  setSetting(SETTINGS_KEYS.AD_FILTER_ENABLED, 'true')
  setSetting(SETTINGS_KEYS.BANNED_KEYWORDS, '广告')
  mocks.adapter = {
    checkLogin: vi.fn(async () => true), getUserInfo: vi.fn(async () => ({ nickname: 'Mock' })),
    listFiles: vi.fn(async (_account, parentId) => ({ files: remote.map(item => ({ ...item })), parentId, hasMore: false })),
    searchFiles: vi.fn(async () => []), mkdir: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(),
    upload: vi.fn(async () => ({ success: true, fileId: 'uploaded' })), copy: vi.fn(async () => {}),
  }
})

describe('archive task relative paths', () => {
  it('persists a protected password through the real IPC and task queue and passes it to extraction', async () => {
    let tempDir = ''
    mocks.adapter.download = vi.fn(async (_account, _fileId, saveDir, options) => {
      tempDir = saveDir
      const localPath = path.join(saveDir, options!.fileName!)
      fs.writeFileSync(localPath, 'archive input')
      return { success: true, localPath }
    })
    try {
      const handlers = new Map<string, TrustedIpcHandler>()
      registerArchivesIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } })
      const result = await handlers.get(IPC_CHANNELS.ARCHIVE_EXTRACT)!({} as IpcMainInvokeEvent, 'account', 'file', 'locked.rar', {
        targetDir: userData, password: ' confidential password ',
      }) as { success: boolean; taskId: string }
      expect(result.success).toBe(true)
      await terminal(result.taskId, 'success')
      const payload = JSON.parse(getTaskById(result.taskId)!.payload)
      expect(JSON.stringify(payload)).not.toContain(' confidential password ')
      expect(payload.options).not.toHaveProperty('password')
      expect(payload.options.encryptedPassword).toBeTruthy()
      expect(vi.mocked(extractArchive).mock.calls.slice(-1)[0]?.[2]).toBe(' confidential password ')
    } finally {
      if (tempDir.startsWith(path.join(os.tmpdir(), 'panlite-archive-extract-'))) fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves nested directories after native path normalization', async () => {
    mocks.adapter.download = vi.fn(async (_account, _fileId, saveDir, options) => {
      const localPath = path.join(saveDir, options!.fileName!)
      fs.mkdirSync(saveDir, { recursive: true })
      fs.writeFileSync(localPath, 'archive input')
      return { success: true, localPath }
    })
    const id = task('archive_compress', {
      files: [{ downloadId: 'nested-file', fileName: 'report.txt', relativePath: 'folder/sub/report.txt', fileSize: 13 }],
      archiveName: 'result.zip', format: 'zip', targetDirId: 'target',
    })
    enqueueTask(id)
    await terminal(id, 'success')
    expect(vi.mocked(createArchive).mock.calls.slice(-1)[0]?.[3]).toEqual([
      expect.objectContaining({ relativePath: 'folder/sub/report.txt', fullPath: expect.stringContaining(path.join('folder', 'sub', 'report.txt')) }),
    ])
  })
})

describe('transfer post-processing file ownership', () => {
  it.each([
    { label: 'missing', names: undefined },
    { label: 'incomplete', names: ['report.txt'] },
  ])('never deletes or shares pre-existing files when saved names are $label', async ({ names }) => {
    remote = [
      remoteFile('old-ad', '旧广告.txt'),
      remoteFile('new-ad', '广告.txt'),
      remoteFile('old-report', 'old-report.txt'),
      remoteFile('new-report', 'report.txt'),
    ]
    const id = transferTask({ savedFileIds: ['new-report', 'new-ad'], savedFileNames: names })
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'account' }), ['new-ad'])
    expectSharedFiles(['new-report'])
  })

  it('keeps the original saved IDs when the directory has no matching new files', async () => {
    remote = [remoteFile('old-ad', '旧广告.txt'), remoteFile('old-report', 'old-report.txt')]
    const savedFileIds = ['new-report', 'not-yet-visible']
    const id = transferTask({ savedFileIds })
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expectSharedFiles(savedFileIds)
  })

  it('keeps the original saved IDs when listing the target directory fails', async () => {
    remote = [remoteFile('old-ad', '旧广告.txt'), remoteFile('old-report', 'old-report.txt')]
    vi.mocked(mocks.adapter.listFiles).mockRejectedValueOnce(new Error('target directory unavailable'))
    const savedFileIds = ['new-report', 'not-yet-visible']
    const id = transferTask({ savedFileIds })
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expectSharedFiles(savedFileIds)
  })

  it('aligns directory names with saved IDs even when the provider returns another order', async () => {
    remote = [
      remoteFile('new-second', 'second.txt'),
      remoteFile('new-ad', '广告.txt'),
      remoteFile('new-first', 'first.txt'),
    ]
    const id = transferTask({ savedFileIds: ['new-first', 'new-ad', 'new-second'] })
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).toHaveBeenCalledWith(expect.anything(), ['new-ad'])
    expectSharedFiles(['new-first', 'new-second'])
  })

  it('passes the root directory ID unchanged to the adapter', async () => {
    remote = [remoteFile('new-report', 'report.txt')]
    const id = transferTask({ savedFileIds: ['new-report'] }, 'quark', '0')
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.listFiles).toHaveBeenCalledWith(expect.objectContaining({ id: 'account' }), '0')
    expectSharedFiles(['new-report'])
  })

  it('aligns confirmed Baidu target IDs and paths independently of directory order', async () => {
    remote = [
      baiduFile('9001', '/target/old-ad.txt', '旧广告.txt'),
      baiduFile('1003', '/target/second.txt', 'second.txt'),
      baiduFile('1002', '/target/ad.txt', '广告.txt'),
      baiduFile('9002', '/target/old-report.txt', 'old-report.txt'),
      baiduFile('1001', '/target/first.txt', 'first.txt'),
    ]
    const id = transferTask({ savedFileIds: ['1001', '1002', '1003'],
      savedFilePaths: ['/target/first.txt', '/target/ad.txt', '/target/second.txt'] }, 'baidu')
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'baidu-account' }), ['/target/ad.txt'])
    expectSharedFiles(['1001', '1003'])
  })

  it('excludes deleted Baidu paths from auto-sharing even when the directory listing is stale', async () => {
    remote = [
      baiduFile('1001', '/target/ad.txt', '广告.txt'),
      baiduFile('1002', '/target/report.txt', 'report.txt'),
      baiduFile('9001', '/target/old-ad.txt', '旧广告.txt'),
      baiduFile('9002', '/target/old-report.txt', 'old-report.txt'),
    ]
    const id = transferTask({ savedFileIds: ['1001', '1002'], savedFileNames: ['广告.txt', 'report.txt'],
      savedFilePaths: ['/target/ad.txt', '/target/report.txt'] }, 'baidu')
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).toHaveBeenCalledWith(expect.anything(), ['/target/ad.txt'])
    expectSharedFiles(['1002'])
  })

  it('skips Baidu auto-sharing when saved paths cannot be confirmed in the target directory', async () => {
    remote = [baiduFile('9001', '/target/old-ad.txt', '旧广告.txt'), baiduFile('9002', '/target/old-report.txt', 'old-report.txt')]
    const id = transferTask({ savedFileIds: ['1001'], savedFileNames: ['report.txt'],
      savedFilePaths: ['/target/report.txt'] }, 'baidu')
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.createShare).not.toHaveBeenCalled()
  })

  it('deletes only new ads and does not auto-share when all saved files are ads', async () => {
    remote = [
      remoteFile('old-report', 'old-report.txt'),
      remoteFile('new-ad-one', '广告-one.txt'),
      remoteFile('old-ad', '旧广告.txt'),
      remoteFile('new-ad-two', '广告-two.txt'),
    ]
    const id = transferTask({ savedFileIds: ['new-ad-two', 'new-ad-one'] })
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.delete).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).toHaveBeenCalledWith(expect.anything(), ['new-ad-two', 'new-ad-one'])
    expect(mocks.adapter.createShare).not.toHaveBeenCalled()
  })

  it.each(['quark', 'baidu'] as const)('finishes %s transfers without post-processing when the adapter returns no saved IDs', async platform => {
    remote = [remoteFile('old-ad', '旧广告.txt'), remoteFile('old-report', 'old-report.txt')]
    const id = transferTask({ savedFileNames: ['广告.txt', 'report.txt'],
      savedFilePaths: platform === 'baidu' ? ['/target/ad.txt', '/target/report.txt'] : undefined }, platform)
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.createShare).not.toHaveBeenCalled()
    expect(mocks.adapter.listFiles).not.toHaveBeenCalled()
  })

  it('reuses a legacy successful transfer checkpoint without trusting its saved IDs for post-processing', async () => {
    const sourceUrl = 'https://mock.invalid/share'
    const saved = { savedFileIds: ['legacy-ad', 'legacy-report'], savedFileNames: ['广告.txt', 'report.txt'] }
    const id = transferTask(saved)
    const timestamp = Date.now()
    getDb().prepare(`INSERT INTO task_operations
      (task_id, operation_key, execution_token, status, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`).run(
      id, taskOperationKey('分享转存', sourceUrl), 'previous-execution-token',
      JSON.stringify({ success: true, platform: 'quark', accountId: 'account', sourceUrl, savedCount: 2, ...saved }),
      timestamp, timestamp,
    )
    enqueueTask(id)
    await terminal(id, 'success')
    expect(mocks.adapter.saveSharedFiles).not.toHaveBeenCalled()
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.createShare).not.toHaveBeenCalled()
    expect(mocks.adapter.listFiles).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  getDb().close()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('task runner remote operation fencing', () => {
  it('revokes a share created by an in-flight request after its task was cancelled', async () => {
    let release!: (value: Awaited<ReturnType<NonNullable<DriveAdapter['createShare']>>>) => void
    mocks.adapter.createShare = vi.fn(() => new Promise<ShareInfo>(resolve => { release = resolve }))
    mocks.adapter.cancelShare = vi.fn(async () => {})
    const shareId = `late-share-${++sequence}`
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(cancelTask(id)).toBe(true)
    release({ id: shareId, platform: 'quark', accountId: 'account', fileIds: ['source'], shareUrl: 'https://mock.invalid/late-public-share', createdAt: Date.now() })
    await terminal(id, 'cancelled')
    expect(mocks.adapter.cancelShare).toHaveBeenCalledWith(expect.objectContaining({ id: 'account' }), shareId)
    expect(listShareLinks().filter(value => value.id === shareId && value.status === 'active')).toEqual([])
    deleteShareLink(shareId)
    expect(retryTask(id)).toBe(true)
    await terminal(id, 'failed')
    expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
  })

  it.each(['unsupported', 'failed'])('retains the known late share for manual cancellation when remote revocation is %s', async outcome => {
    let release!: (value: Awaited<ReturnType<NonNullable<DriveAdapter['createShare']>>>) => void
    mocks.adapter.createShare = vi.fn(() => new Promise<ShareInfo>(resolve => { release = resolve }))
    mocks.adapter.cancelShare = outcome === 'unsupported' ? undefined : vi.fn(async () => { throw new Error('revoke unavailable') })
    const shareId = `unrevoked-share-${++sequence}`
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(cancelTask(id)).toBe(true)
    release({ id: shareId, platform: 'quark', accountId: 'account', fileIds: ['source'], shareUrl: 'https://mock.invalid/unrevoked-share', createdAt: Date.now() })
    await terminal(id, 'cancelled')
    expect(listShareLinks().find(value => value.id === shareId)).toMatchObject({ status: 'active', share_url: 'https://mock.invalid/unrevoked-share' })
    deleteShareLink(shareId)
    expect(retryTask(id)).toBe(true)
    await terminal(id, 'failed')
    expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
  })

  it('revokes a known late result even when its cancelled task was immediately deleted', async () => {
    let release!: (value: Awaited<ReturnType<NonNullable<DriveAdapter['createShare']>>>) => void
    mocks.adapter.createShare = vi.fn(() => new Promise<ShareInfo>(resolve => { release = resolve }))
    mocks.adapter.cancelShare = vi.fn(async () => {})
    const shareId = `deleted-task-share-${++sequence}`
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(cancelTask(id)).toBe(true)
    expect(deleteTaskById(id)).toBe(true)
    release({ id: shareId, platform: 'quark', accountId: 'account', fileIds: ['source'], shareUrl: 'https://mock.invalid/deleted-task-share', createdAt: Date.now() })
    await vi.waitFor(() => expect(mocks.adapter.cancelShare).toHaveBeenCalledWith(expect.objectContaining({ id: 'account' }), shareId))
    await vi.waitFor(() => expect(Object.values(getQueueStatus()).every(queue => !queue.running && !queue.pending)).toBe(true))
    expect(getTaskById(id)).toBeUndefined()
    expect(listShareLinks().find(value => value.id === shareId)?.status).toBe('cancelled')
  })

  it('reuses a completed share after pause/resume without revoking or dispatching it twice', async () => {
    let release!: (value: Awaited<ReturnType<NonNullable<DriveAdapter['createShare']>>>) => void
    mocks.adapter.createShare = vi.fn(() => new Promise<ShareInfo>(resolve => { release = resolve }))
    mocks.adapter.cancelShare = vi.fn(async () => {})
    const shareId = `paused-task-share-${++sequence}`
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(pauseTask(id)).toBe(true)
    release({ id: shareId, platform: 'quark', accountId: 'account', fileIds: ['source'], shareUrl: 'https://mock.invalid/paused-task-share', createdAt: Date.now() })
    await terminal(id, 'paused')
    expect(mocks.adapter.cancelShare).not.toHaveBeenCalled()
    expect(resumeTask(id)).toBe(true)
    await terminal(id, 'success')
    expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
    expect(listShareLinks().find(value => value.id === shareId)?.status).toBe('active')
  })

  it('persists a late share through a retry queued before the cancelled worker returns', async () => {
    let release!: (value: ShareInfo) => void
    mocks.adapter.createShare = vi.fn(() => new Promise<ShareInfo>(resolve => { release = resolve }))
    mocks.adapter.cancelShare = vi.fn(async () => {})
    const shareId = `immediate-retry-share-${++sequence}`
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(cancelTask(id)).toBe(true)
    expect(retryTask(id)).toBe(true)
    expect(getTaskById(id)?.status).toBe('pending')
    release({ id: shareId, platform: 'quark', accountId: 'account', fileIds: ['source'], shareUrl: 'https://mock.invalid/immediate-retry-share', createdAt: Date.now() })
    await terminal(id, 'success')
    expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.cancelShare).not.toHaveBeenCalled()
    expect(listShareLinks().find(value => value.id === shareId)).toMatchObject({ status: 'active', share_url: 'https://mock.invalid/immediate-retry-share' })
  })

  it('preserves an existing remote file when an overwrite source disappears while queued', async () => {
    remote = [remoteFile('old-report', 'report.txt')]
    const missing = path.join(userData, 'missing-before-execution', 'report.txt')
    const id = task('upload', { targetDirId: 'target', conflictPolicy: 'overwrite', files: [{ localPath: missing, fileName: 'report.txt', fileSize: 42 }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.upload).not.toHaveBeenCalled()
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.rename).not.toHaveBeenCalled()
    expect(remote).toEqual([expect.objectContaining({ id: 'old-report' })])
  })

  it('preserves the original on a failed staged upload and never replays an ambiguous write', async () => {
    remote = [remoteFile('old-report', 'report.txt')]
    const localPath = path.join(userData, 'overwrite-report.txt'); fs.writeFileSync(localPath, 'x'.repeat(42))
    mocks.adapter.upload = vi.fn(async () => ({ success: false, error: 'upload failed' }))
    const id = task('upload', { targetDirId: 'target', conflictPolicy: 'overwrite', files: [{ localPath, fileName: 'report.txt', fileSize: 42 }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(retryTask(id)).toBe(true)
    await terminal(id, 'failed')
    expect(mocks.adapter.upload).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.rename).not.toHaveBeenCalled()
    expect(remote).toEqual([expect.objectContaining({ id: 'old-report' })])
    expect(getTaskById(id)?.error_message).toContain('远端操作结果待核对')
  })

  it('does not delete a remote file to create an upload directory in its place', async () => {
    remote = [remoteFile('old-directory-name', 'folder')]
    const id = task('upload', { targetDirId: 'target', conflictPolicy: 'overwrite', files: [{ localPath: 'report.txt', fileName: 'report.txt', fileSize: 42, relativePath: 'folder/report.txt' }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.mkdir).not.toHaveBeenCalled()
    expect(remote).toEqual([expect.objectContaining({ id: 'old-directory-name' })])
  })

  it.each(['nested', 'selected-root'])('rejects %s download junctions without writing outside the selected directory', async location => {
    const scratch = fs.mkdtempSync(path.join(userData, 'download-guard-'))
    const downloads = path.join(scratch, 'downloads'), outside = path.join(scratch, 'outside')
    fs.mkdirSync(downloads); fs.mkdirSync(outside)
    const linked = location === 'nested' ? path.join(downloads, 'folder') : path.join(scratch, 'root-link')
    fs.symlinkSync(outside, linked, 'junction')
    try {
      mocks.adapter.listFiles = vi.fn(async (_account, parentId) => ({ parentId, hasMore: false, files: [remoteFile('cloud-child', 'new.txt')] }))
      mocks.adapter.download = vi.fn(async () => { throw new Error('must not download') })
      const id = task('download', { targetDirPath: location === 'nested' ? downloads : linked, conflictPolicy: 'overwrite',
        files: [{ fileId: 'cloud-folder', fileName: 'folder', fileSize: 0, isDir: true }] })
      enqueueTask(id)
      await terminal(id, 'failed')
      expect(getTaskById(id)?.error_message).toContain('目录联接')
      expect(mocks.adapter.download).not.toHaveBeenCalled()
      expect(fs.readdirSync(outside)).toEqual([])
    } finally { fs.unlinkSync(linked) }
  })

  it('does not unlink an existing local file to start downloading a cloud directory', async () => {
    const downloads = fs.mkdtempSync(path.join(userData, 'directory-overwrite-'))
    const original = path.join(downloads, 'folder'); fs.writeFileSync(original, 'valuable local bytes')
    mocks.adapter.download = vi.fn()
    const id = task('download', { targetDirPath: downloads, conflictPolicy: 'overwrite',
      files: [{ fileId: 'cloud-folder', fileName: 'folder', fileSize: 0, isDir: true }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(fs.readFileSync(original, 'utf8')).toBe('valuable local bytes')
    expect(mocks.adapter.download).not.toHaveBeenCalled()
    expect(mocks.adapter.listFiles).not.toHaveBeenCalled()
  })

  it.each(['rename', 'overwrite'])('does not repeat uploads or conflict mutations after a lost response (%s)', async policy => {
    mocks.adapter.upload = vi.fn(async () => {
      remote.push({ id: 'remote-file', parentId: 'target', name: 'test-file.txt', isDir: false, size: 42,
        createdAt: 0, updatedAt: 0, accountId: 'account', platform: 'quark' })
      throw new Error('network response lost after commit')
    })
    const id = uploadTask(policy)
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(retryTask(id)).toBe(true)
    await terminal(id, 'failed')
    expect(getTaskById(id)?.error_message).toContain('远端操作结果待核对')
    expect(mocks.adapter.upload).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.delete).not.toHaveBeenCalled()
    expect(mocks.adapter.rename).not.toHaveBeenCalled()
  })

  it('retries a read-only failure before sending any upload request', async () => {
    vi.mocked(mocks.adapter.listFiles).mockRejectedValueOnce(new Error('network list failure'))
    const id = uploadTask()
    enqueueTask(id)
    await terminal(id, 'failed')
    expect(retryTask(id)).toBe(true)
    await terminal(id, 'success')
    expect(mocks.adapter.upload).toHaveBeenCalledTimes(1)
  })

  it('preserves pause/resume before dispatch and fences the old callback', async () => {
    let release!: (value: { files: FileItem[]; parentId: string; hasMore: boolean }) => void
    vi.mocked(mocks.adapter.listFiles).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const id = uploadTask()
    enqueueTask(id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(pauseTask(id)).toBe(true)
    expect(resumeTask(id)).toBe(true)
    release({ files: [], parentId: 'target', hasMore: false })
    await terminal(id, 'success')
    expect(mocks.adapter.upload).toHaveBeenCalledTimes(1)
  })

  it('does not repeat native copy after an ambiguous provider failure', async () => {
    mocks.adapter.copy = vi.fn(async () => { throw new Error('network response lost') })
    const id = task('cloud_transfer', { sourceAccountId: 'account', targetAccountId: 'account',
      sourcePlatform: 'quark', targetPlatform: 'quark', targetDirId: 'target', conflictPolicy: 'skip',
      files: [{ fileId: 'source', fileName: 'source.txt', fileSize: 42, isDir: false }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    retryTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.copy).toHaveBeenCalledTimes(1)
    expect(getTaskById(id)?.error_message).toContain('远端操作结果待核对')
  })

  it('does not treat a false transfer result as success or send it again on retry', async () => {
    mocks.adapter.saveSharedFiles = vi.fn(async () => ({ success: false, error: 'remote status unknown',
      platform: 'quark' as const, accountId: 'account', sourceUrl: 'https://mock.invalid/share' }))
    const id = task('transfer', { links: [{ url: 'https://mock.invalid/share' }], targetDirId: 'target' })
    enqueueTask(id)
    await terminal(id, 'failed')
    retryTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.saveSharedFiles).toHaveBeenCalledTimes(1)
  })

  it('does not create another share after losing the first share response', async () => {
    mocks.adapter.createShare = vi.fn(async () => { throw new Error('network response lost') })
    const id = task('share', { items: [{ fileId: 'source', name: 'report.txt' }] })
    enqueueTask(id)
    await terminal(id, 'failed')
    retryTask(id)
    await terminal(id, 'failed')
    expect(mocks.adapter.createShare).toHaveBeenCalledTimes(1)
    expect(getTaskById(id)?.error_message).toContain('远端操作结果待核对')
  })

  it('keeps task IPC responses and renderer trust checks after domain extraction', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173')
    try {
      const handlers = new Map<string, TrustedIpcHandler>()
      registerTasksIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, wrapTrustedIpcHandler(listener)) } })
      const event = (url: string) => ({ senderFrame: { url }, sender: { getURL: () => url } }) as unknown as IpcMainInvokeEvent
      const id = uploadTask()
      const list = handlers.get(IPC_CHANNELS.TASK_LIST)!
      await expect(list(event('https://external.invalid'))).rejects.toThrow('未经授权')
      const result = await list(event('http://localhost:5173')) as { success: boolean; tasks: Array<Record<string, unknown>> }
      expect(result.success).toBe(true)
      expect(result.tasks.find(item => item.id === id)).toMatchObject({ taskType: 'upload', accountId: 'account', retryCount: 3 })
      expect(result.tasks.find(item => item.id === id)).not.toHaveProperty('execution_token')
      expect(await handlers.get(IPC_CHANNELS.TASK_DELETE)!(event('http://localhost:5173'), id)).toMatchObject({ success: false })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
