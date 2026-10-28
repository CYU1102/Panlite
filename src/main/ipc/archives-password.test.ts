import os from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { TrustedIpcHandler } from '../ipc-security'

const mocks = vi.hoisted(() => ({ account: vi.fn(), create: vi.fn(), protect: vi.fn() }))
vi.mock('../db', () => ({ getAccountById: mocks.account }))
vi.mock('../../adapters/registry', () => ({ getAdapter: () => ({ download: vi.fn() }) }))
vi.mock('../task-runner', () => ({ createAndEnqueueTask: mocks.create }))
vi.mock('../archive', () => ({ listArchiveFiles: vi.fn(), cleanupTempDir: vi.fn() }))
vi.mock('./account-mapping', () => ({ dbAccountToDriveAccount: () => ({ platform: 'quark' }) }))
vi.mock('../archive-task-password', () => ({ protectArchiveTaskOptions: mocks.protect }))
import { registerArchivesIpcHandlers } from './archives'

function handler(): TrustedIpcHandler {
  const handlers = new Map<string, TrustedIpcHandler>()
  registerArchivesIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener) } })
  return handlers.get(IPC_CHANNELS.ARCHIVE_EXTRACT)!
}
beforeEach(() => { vi.resetAllMocks(); mocks.account.mockReturnValue({ id: 'account' }) })

describe('creating protected archive tasks', () => {
  it('does not create a task if the account is deleted while password protection is pending', async () => {
    let resolve!: (value: unknown) => void
    mocks.protect.mockReturnValue(new Promise(done => { resolve = done }))
    const pending = handler()({} as IpcMainInvokeEvent, 'account', 'file', 'test.rar', { targetDir: os.tmpdir(), password: 'fixture' })
    mocks.account.mockReturnValue(null)
    resolve({ targetDir: os.tmpdir(), encryptedPassword: 'protected' })
    expect(await pending).toMatchObject({ success: false, error: '账号不存在' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('does not create a task when password protection fails', async () => {
    mocks.protect.mockRejectedValue(new Error('系统安全存储不可用'))
    const result = await handler()({} as IpcMainInvokeEvent, 'account', 'file', 'test.rar', { targetDir: os.tmpdir(), password: 'fixture' })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('系统安全存储不可用') })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
