import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from './types'
import { IPC_CHANNELS } from '../../shared/constants'

const fixture = vi.hoisted(() => ({ directory: '', clearLogin: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory }, BrowserWindow: {}, shell: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../crypto', () => ({ encryptCredential: (value: string) => value, decryptCredential: (value: string) => value }))
vi.mock('../login-window', () => ({ clearQuarkLoginSession: fixture.clearLogin, openQuarkLoginWindow: vi.fn(), openBaiduLoginWindow: vi.fn() }))
vi.mock('../../adapters/registry', () => ({ getAdapter: vi.fn() }))
vi.mock('../../adapters/baidu', () => ({ baiduAdapter: { setCredentialRefreshHandler: vi.fn(), setSessionInvalidatedHandler: vi.fn(), stopKeepalive: vi.fn() }, setBaiduCredentials: vi.fn(), baiduExchangeCode: vi.fn(), baiduGetAuthUrl: vi.fn() }))
vi.mock('../../adapters/uc', () => ({ ucAdapter: {} }))
vi.mock('../../adapters/xunlei', () => ({ xunleiAdapter: { setCredentialRefreshHandler: vi.fn() } }))
vi.mock('../../adapters/aliyun', () => ({ exchangeAliyunCode: vi.fn(), setAliyunCredentialRefreshHandler: vi.fn() }))
vi.mock('../../adapters/aliyun-web', () => ({ setAliyunWebCredentialRefreshHandler: vi.fn() }))
vi.mock('../../adapters/pan123', () => ({ fetchPan123AccessToken: vi.fn(), setPan123CredentialRefreshHandler: vi.fn() }))
import { getDb, getAccountById, getTaskById, initDatabase, insertAccount, insertTask } from '../db'
import { registerAccountsIpcHandlers } from './accounts'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
beforeAll(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-account-delete-race-'))
  vi.useFakeTimers(); initDatabase()
  registerAccountsIpcHandlers({ handle(channel, listener) { handlers.set(channel, listener as (...args: unknown[]) => unknown) } } as IpcRegistrar)
})
afterAll(() => { getDb().close(); vi.clearAllTimers(); vi.useRealTimers(); fs.rmSync(fixture.directory, { recursive: true, force: true }) })

it.each(['owned', 'migration-target'])('keeps an account when a new %s task is submitted during asynchronous login cleanup', async relationship => {
  const accountId = `delete-race-account-${relationship}`, taskId = `delete-race-task-${relationship}`
  insertAccount({ id: accountId, platform: 'quark', nickname: 'Synthetic account', login_type: 'cookie', encrypted_credential: '{}', user_agent: null,
    status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
  let release!: () => void
  fixture.clearLogin.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const deletion = handlers.get(IPC_CHANNELS.ACCOUNT_DELETE)!({}, accountId)
  expect(release).toBeTypeOf('function')
  insertTask({ id: taskId, account_id: relationship === 'owned' ? accountId : 'another-source', platform: 'quark', task_type: relationship === 'owned' ? 'upload' : 'cloud_transfer',
    title: 'Submitted during cleanup', payload: JSON.stringify({ targetAccountId: accountId }), status: 'pending',
    progress: 0, retry_count: 0, execution_token: null, error_message: null, created_at: 1, updated_at: 1, finished_at: null })
  release()
  await expect(deletion).resolves.toMatchObject({ success: false, error: expect.stringContaining('未结束任务') })
  expect(getAccountById(accountId)).toBeDefined()
  expect(getTaskById(taskId)?.status).toBe('pending')
})
