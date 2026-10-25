import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { getSetting, setSetting } from '../db'
import log from 'electron-log'
import { AppLock, type AppLockRecord } from '../app-lock'
import type { IpcRegistrar } from './types'

const APP_LOCK_SETTING = 'app_lock_record'
let appLock: AppLock | null = null
let appLockTimer: ReturnType<typeof setInterval> | null = null
function appLockState(): Record<string, unknown> {
  try {
    const snapshot = appLock?.snapshot() || { enabled: false, status: 'disabled', reason: null, autoLockMs: 0, failedAttempts: 0, retryAfterMs: 0, lastActivityAt: null }
    return { ...snapshot, locked: snapshot.enabled && snapshot.status !== 'unlocked' }
  } catch (err) {
    // A corrupted/old persisted record must not make the Security page or IPC handler crash.
    log.error('Failed to read app lock state; treating app lock as disabled:', String(err))
    return { enabled: false, status: 'disabled', reason: null, autoLockMs: 0, failedAttempts: 0, retryAfterMs: 0, lastActivityAt: null, locked: false, error: '应用锁配置已损坏，请重新设置' }
  }
}

function broadcastAppLockState(): void {
  const state = appLockState()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.APP_LOCK_CHANGED, state)
  }
}

function persistAppLock(): void {
  const record = appLock?.exportRecord()
  if (record) setSetting(APP_LOCK_SETTING, JSON.stringify(record))
  else setSetting(APP_LOCK_SETTING, '')
}

function initializeAppLock(): void {
  const saved = getSetting(APP_LOCK_SETTING)?.value
  let record: AppLockRecord | null = null
  if (saved) {
    try { record = JSON.parse(saved) as AppLockRecord } catch (err) { log.warn('Invalid app lock record:', String(err)) }
  }
  try {
    appLock = new AppLock({ record })
  } catch (err) {
    // Older builds may have persisted a record that the current validator rejects.
    // Reset only the app-lock setting, leaving accounts and other credentials intact.
    log.error('Invalid persisted app lock record, resetting it:', String(err))
    try { setSetting(APP_LOCK_SETTING, '') } catch (resetError) { log.error('Failed to reset app lock setting:', String(resetError)) }
    appLock = new AppLock()
  }
  const lock = appLock
  appLockTimer = setInterval(() => {
    const before = appLockState()
    lock.tick()
    const after = appLockState()
    if (before.status !== after.status || before.locked !== after.locked) broadcastAppLockState()
  }, 1_000)
}

export function cleanupSecurityIpc(): void {
  if (appLockTimer) clearInterval(appLockTimer)
  appLockTimer = null
  appLock = null
}

export function registerSecurityIpcHandlers(ipcMain: IpcRegistrar): void {
  initializeAppLock()
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_STATUS, async () => ({ success: true, ...appLockState() }))
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_CONFIGURE, async (_event, input: { password: string; autoLockMs?: number }) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.configure(String(input?.password || ''), Number(input?.autoLockMs ?? 5 * 60_000))
      persistAppLock()
      const state = appLockState()
      broadcastAppLockState()
      return { success: true, ...state }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_UNLOCK, async (_event, password: string) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      const result = await appLock.unlock(String(password || ''))
      const state = appLockState()
      broadcastAppLockState()
      return { success: result.success, ...state, error: result.success ? undefined : '密码错误或暂时不可重试' }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_CHANGE_PASSWORD, async (_event, input: { currentPassword: string; newPassword: string }) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.changePassword(String(input?.currentPassword || ''), String(input?.newPassword || ''))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_DISABLE, async (_event, password: string) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      await appLock.disable(String(password || ''))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_SET_AUTO_LOCK, async (_event, autoLockMs: number) => {
    try {
      if (!appLock) throw new Error('应用锁未初始化')
      appLock.setAutoLockMs(Number(autoLockMs))
      persistAppLock()
      broadcastAppLockState()
      return { success: true, ...appLockState() }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_NOW, async () => {
    if (!appLock) return { success: false, error: '应用锁未初始化' }
    appLock.lock('manual')
    broadcastAppLockState()
    return { success: true, ...appLockState() }
  })
  ipcMain.handle(IPC_CHANNELS.APP_LOCK_TOUCH, async () => {
    appLock?.noteActivity()
    return { success: true, ...appLockState() }
  })
}
