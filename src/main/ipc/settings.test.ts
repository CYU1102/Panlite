import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/constants'
import { registerSettingsIpcHandlers } from './settings'
import { getRequestSettings, resetRequestSettings } from '../request-settings'
import { initGlobalShortcuts, isGlobalShortcutsActive, releaseGlobalShortcuts } from '../global-shortcuts'
import type { IpcRegistrar } from './types'

const mocks = vi.hoisted(() => ({
  settings: new Map<string, { key: string; value: string; encrypted: number }>(),
  encrypt: vi.fn(), decrypt: vi.fn(), register: vi.fn(), unregister: vi.fn(), importBackup: vi.fn(), refreshTaskScheduling: vi.fn(),
}))
vi.mock('electron', () => ({
  dialog: {}, BrowserWindow: { getFocusedWindow: vi.fn() }, nativeTheme: {},
  globalShortcut: { register: mocks.register, unregisterAll: mocks.unregister },
}))
vi.mock('../db', () => ({
  getSetting: (key: string) => mocks.settings.get(key),
  getAllSettings: () => [...mocks.settings.values()],
  setSetting: (key: string, value: string, encrypted = false) => mocks.settings.set(key, { key, value, encrypted: Number(encrypted) }),
}))
vi.mock('../crypto', () => ({ encryptCredential: mocks.encrypt, decryptCredential: mocks.decrypt }))
vi.mock('../clipboard-monitor', () => ({ getClipboardMonitor: () => undefined }))
vi.mock('../share-subscriptions', () => ({ getShareSubscriptionScheduler: () => undefined }))
vi.mock('../task-runner', () => ({ refreshTaskScheduling: mocks.refreshTaskScheduling }))
vi.mock('../../adapters/baidu', () => ({ setBaiduCredentials: vi.fn() }))
vi.mock('../config-backup', () => ({ importConfigBackup: mocks.importBackup, previewConfigBackupImport: vi.fn(), serializeConfigBackup: vi.fn() }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), info: vi.fn() } }))

type Handler = (...args: any[]) => any
let handlers: Map<string, Handler>
function setup(): void {
  registerSettingsIpcHandlers({ handle: (name, handler) => handlers.set(name, handler) } as IpcRegistrar)
}
async function call(channel: string, ...args: unknown[]): Promise<any> {
  return handlers.get(channel)!({}, ...args)
}

beforeEach(() => {
  mocks.settings.clear()
  mocks.encrypt.mockReset().mockImplementation((value: string) => `encrypted:${value}`)
  mocks.decrypt.mockReset().mockImplementation((value: string) => value.slice('encrypted:'.length))
  mocks.register.mockReset().mockReturnValue(true)
  mocks.unregister.mockReset()
  mocks.importBackup.mockReset()
  mocks.refreshTaskScheduling.mockReset()
  releaseGlobalShortcuts()
  initGlobalShortcuts({ toggleWindow: vi.fn(), navigateTo: vi.fn() })
  resetRequestSettings()
  handlers = new Map()
})

describe('settings IPC persistence and runtime state', () => {
  it('refreshes pending admission immediately after valid timing edits and rejects invalid edits without changing runtime', async () => {
    setup()
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'transferScheduledWindow', '23:00-06:00')).toEqual({ success: true })
    expect(mocks.settings.get('transferScheduledWindow')?.value).toBe('23:00-06:00')
    expect(mocks.refreshTaskScheduling).toHaveBeenCalledTimes(1)
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'transferScheduledWindow', '25:00-06:00')).toMatchObject({ success: false })
    expect(mocks.settings.get('transferScheduledWindow')?.value).toBe('23:00-06:00')
    expect(mocks.refreshTaskScheduling).toHaveBeenCalledTimes(1)
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'transferPauseAtWindowEnd', 'true')).toEqual({ success: true })
    expect(mocks.refreshTaskScheduling).toHaveBeenCalledTimes(2)
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'transferPauseAtWindowEnd', 'sometimes')).toMatchObject({ success: false })
    expect(mocks.settings.get('transferPauseAtWindowEnd')?.value).toBe('true')
    expect(mocks.refreshTaskScheduling).toHaveBeenCalledTimes(2)
  })

  it('encrypts Aliyun application secrets and returns an explicit success result', async () => {
    setup()
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'aliyunClientSecret', 'fixture-secret')).toEqual({ success: true })
    expect(mocks.settings.get('aliyunClientSecret')).toMatchObject({ value: 'encrypted:fixture-secret', encrypted: 1 })
    expect(await call(IPC_CHANNELS.SETTINGS_GET, 'aliyunClientSecret')).toEqual({ success: true, value: 'fixture-secret' })
  })

  it('upgrades the existing plaintext Aliyun secret through the normal encryption path', () => {
    mocks.settings.set('aliyunClientSecret', { key: 'aliyunClientSecret', value: 'legacy-fixture', encrypted: 0 })
    setup()
    expect(mocks.settings.get('aliyunClientSecret')).toMatchObject({ value: 'encrypted:legacy-fixture', encrypted: 1 })
  })

  it('does not save plaintext if encryption fails', async () => {
    setup()
    mocks.encrypt.mockImplementation(() => { throw new Error('encryption unavailable') })
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'aliyunClientSecret', 'fixture-secret')).toMatchObject({ success: false })
    expect(mocks.settings.has('aliyunClientSecret')).toBe(false)
  })

  it('rejects invalid request settings without changing either stored or active values', async () => {
    setup()
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'quarkPageSize', '300')).toEqual({ success: true })
    expect(await call(IPC_CHANNELS.SETTINGS_SET, 'quarkPageSize', 'invalid')).toMatchObject({ success: false })
    expect(mocks.settings.get('quarkPageSize')?.value).toBe('300')
    expect(getRequestSettings().quarkPageSize).toBe(300)
  })

  it('applies restored settings immediately, including defaults for removed preferences', async () => {
    setup()
    await call(IPC_CHANNELS.SETTINGS_SET, 'requestDelayMs', '1000')
    mocks.importBackup.mockImplementation(() => {
      mocks.settings.clear()
      mocks.settings.set('quarkPageSize', { key: 'quarkPageSize', value: '400', encrypted: 0 })
      return { restoredAt: 'fixture' }
    })
    expect(await call(IPC_CHANNELS.CONFIG_BACKUP_IMPORT, 'fixture', { mode: 'replace' })).toMatchObject({ success: true })
    expect(getRequestSettings()).toEqual({ quarkPageSize: 400, baiduPageSize: 100, requestDelayMs: 300 })
  })

  it('keeps a committed merge successful when it preserves a corrupt legacy request setting', async () => {
    mocks.settings.set('baiduPageSize', { key: 'baiduPageSize', value: 'invalid', encrypted: 0 })
    setup()
    mocks.importBackup.mockImplementation(() => {
      mocks.settings.set('quarkPageSize', { key: 'quarkPageSize', value: '400', encrypted: 0 })
      mocks.settings.set('requestDelayMs', { key: 'requestDelayMs', value: '750', encrypted: 0 })
      return { restoredAt: 'fixture' }
    })
    expect(await call(IPC_CHANNELS.CONFIG_BACKUP_IMPORT, 'fixture', { mode: 'merge' })).toMatchObject({ success: true })
    expect(getRequestSettings()).toEqual({ quarkPageSize: 400, baiduPageSize: 100, requestDelayMs: 750 })
  })

  it('reports the actual disabled state when turning off global shortcuts', async () => {
    setup()
    expect(await call(IPC_CHANNELS.SHORTCUTS_SET, true)).toEqual({ success: true, enabled: true })
    expect(await call(IPC_CHANNELS.SHORTCUTS_SET, false)).toEqual({ success: true, enabled: false })
    expect(isGlobalShortcutsActive()).toBe(false)
  })

  it('reports registration conflicts as failures and clears partially registered shortcuts', async () => {
    setup()
    mocks.register.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(await call(IPC_CHANNELS.SHORTCUTS_SET, true)).toMatchObject({ success: false, enabled: false })
    expect(mocks.unregister).toHaveBeenCalled()
  })
})
