import { dialog, BrowserWindow, nativeTheme } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { SETTINGS_KEYS } from '../../shared/constants'
import { getSetting, setSetting, getAllSettings } from '../db'
import { getClipboardMonitor } from '../clipboard-monitor'
import { isGlobalShortcutsActive, setGlobalShortcutsEnabled } from '../global-shortcuts'
import { encryptCredential, decryptCredential } from '../crypto'
import { setBaiduCredentials } from '../../adapters/baidu'
import { configureRequestSettings, DEFAULT_REQUEST_SETTINGS, isRequestSettingKey, normalizeRequestSetting } from '../request-settings'
import log from 'electron-log'
import { getShareSubscriptionScheduler } from '../share-subscriptions'
import { importConfigBackup, previewConfigBackupImport, serializeConfigBackup } from '../config-backup'
import type { IpcRegistrar } from './types'
import { isValidTransferWindow } from '../../shared/task-scheduling'
import { refreshTaskScheduling } from '../task-runner'

function applyPersistedRequestSettings(): void {
  const settings = { ...DEFAULT_REQUEST_SETTINGS }
  for (const key of ['quarkPageSize', 'baiduPageSize', 'requestDelayMs'] as const) {
    try {
      const value = getSetting(key)?.value
      if (value !== undefined && value !== '') settings[key] = normalizeRequestSetting(key, value)
    } catch (err) {
      log.warn(`Invalid persisted request setting ${key}, using default:`, String(err))
    }
  }
  configureRequestSettings(settings)
}

export function registerSettingsIpcHandlers(ipcMain: IpcRegistrar): void {
  // Older versions omitted this secret from the encrypted settings list.
  try {
    const legacySecret = getSetting('aliyunClientSecret')
    if (legacySecret?.value && !legacySecret.encrypted) {
      setSetting('aliyunClientSecret', encryptCredential(legacySecret.value), true)
    }
  } catch (err) {
    log.warn('Could not encrypt legacy Aliyun application secret:', String(err))
  }
  // Settings are held in a small runtime store so every adapter sees changes
  // immediately without reaching into SQLite from its request loop.
  applyPersistedRequestSettings()


  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_EXPORT, async () => {
    try {
      return { success: true, backup: serializeConfigBackup() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_PREVIEW, async (_event, input: string, options?: { mode?: 'merge' | 'replace' }) => {
    try {
      return { success: true, preview: previewConfigBackupImport(input, options) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_BACKUP_IMPORT, async (_event, input: string, options?: { mode?: 'merge' | 'replace' }) => {
    try {
      const result = importConfigBackup(input, options)
      applyPersistedRequestSettings()
      return { success: true, result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })


  // ---- System ----

  ipcMain.handle(IPC_CHANNELS.DIALOG_SAVE, async (_event, options: Electron.SaveDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    return dialog.showSaveDialog(win, options)
  })

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN, async (_event, options: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true }
    return dialog.showOpenDialog(win, options)
  })

  // ---- Settings handlers ----

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    try {
      const row = getSetting(key)
      if (!row) return { success: true, value: null }
      if (row.encrypted) {
        try {
          const decrypted = decryptCredential(row.value)
          return { success: true, value: decrypted }
        } catch {
          return { success: true, value: '' }
        }
      }
      return { success: true, value: row.value }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, key: string, value: string) => {
    try {
      let storedValue = value
      if (key === 'transferScheduledWindow' && !isValidTransferWindow(value)) throw new Error('传输时段应为 HH:MM-HH:MM，留空不限')
      if (key === 'transferPauseAtWindowEnd' && !['true', 'false'].includes(value)) throw new Error('时段结束策略无效')
      if (isRequestSettingKey(key)) {
        storedValue = String(normalizeRequestSetting(key, value))
      }

      // Encrypt sensitive settings
      const encryptedKeys = ['baiduClientSecret', 'aliyunClientSecret', 'aiProviderApiKey']
      const shouldEncrypt = encryptedKeys.includes(key)

      if (shouldEncrypt && storedValue) {
        const encrypted = encryptCredential(storedValue)
        setSetting(key, encrypted, true)
      } else {
        setSetting(key, storedValue, false)
      }

      if (isRequestSettingKey(key)) {
        configureRequestSettings({ [key]: storedValue })
      }
      if (key === 'shareSubscriptionIntervalMinutes') {
        getShareSubscriptionScheduler()?.restart()
      }
      if (key === 'transferScheduledWindow' || key === 'transferPauseAtWindowEnd') refreshTaskScheduling()

      // Apply Baidu credentials immediately when saved
      if (key === 'baiduClientId' || key === 'baiduClientSecret' || key === 'baiduRedirectUri') {
        const clientIdRow = getSetting('baiduClientId')
        const clientSecretRow = getSetting('baiduClientSecret')
        const redirectUriRow = getSetting('baiduRedirectUri')
        const clientId = clientIdRow?.value || ''
        let clientSecret = ''
        if (clientSecretRow) {
          try {
            clientSecret = clientSecretRow.encrypted ? decryptCredential(clientSecretRow.value) : clientSecretRow.value
          } catch { /* ignore */ }
        }
        const redirectUri = redirectUriRow?.value || ''
        if (clientId && clientSecret) {
          setBaiduCredentials(clientId, clientSecret, redirectUri || undefined)
          log.info('Baidu credentials updated from settings')
        }
      }

      // 原生菜单栏/标题栏跟随应用主题
      if (key === 'theme' && (value === 'dark' || value === 'light')) {
        nativeTheme.themeSource = value
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    try {
      const rows = getAllSettings()
      const settings: Record<string, string> = {}
      for (const row of rows) {
        if (row.encrypted) {
          try {
            settings[row.key] = decryptCredential(row.value)
          } catch {
            settings[row.key] = ''
          }
        } else {
          settings[row.key] = row.value
        }
      }
      return { success: true, settings }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Clipboard monitor ----
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_MONITOR_GET, async () => {
    try {
      return { success: true, enabled: getClipboardMonitor()?.isRunning() ?? false }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_MONITOR_SET, async (_event, enabled: boolean) => {
    try {
      const shouldEnable = Boolean(enabled)
      setSetting(SETTINGS_KEYS.CLIPBOARD_MONITOR_ENABLED, String(shouldEnable))
      const monitor = getClipboardMonitor()
      if (!monitor) return { success: false, error: '剪贴板监听尚未初始化' }
      if (shouldEnable) monitor.start()
      else monitor.stop()
      return { success: true, enabled: monitor.isRunning() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Global shortcuts ----
  ipcMain.handle(IPC_CHANNELS.SHORTCUTS_GET, async () => {
    try {
      return { success: true, enabled: isGlobalShortcutsActive() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.SHORTCUTS_SET, async (_event, enabled: boolean) => {
    try {
      const success = setGlobalShortcutsEnabled(Boolean(enabled))
      return { success, enabled: isGlobalShortcutsActive(), ...(success ? {} : { error: '快捷键注册失败，可能已被其他应用占用' }) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}
