import { app, BrowserWindow, dialog } from 'electron'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import log from 'electron-log'
import { createMainWindow } from './window'
import { getAllAccounts, getSetting, initDatabase, updateAccountStatus, type DbAccount } from './db'
import { cleanupIpcResources, registerIpcHandlers } from './ipc'
import { resumePendingTasks } from './task-runner'
import { decryptCredential } from './crypto'
import { getAdapter } from '../adapters/registry'
import type { DriveAccount } from '../shared/types'
import { IPC_CHANNELS } from '../shared/constants'
import { createTrayNotificationManager, type TrayNotificationManager } from './tray-notifications'
import { createAccountHealthScheduler, type AccountHealthScheduler } from './account-health'
import { disposeRuntimeServices, setTrayNotificationManager } from './runtime-services'
import { createLogSanitizer } from './log-sanitizer'

// Configure electron-log
log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
log.transports.console.level = 'info'
log.transports.file.level = 'info'
const sanitizeLogMessage = createLogSanitizer()
log.hooks.push((message) => sanitizeLogMessage(message) as typeof message)

let mainWindow: BrowserWindow | null = null
let trayNotifications: TrayNotificationManager | null = null
let healthScheduler: AccountHealthScheduler<DriveAccount> | null = null
let isQuitting = false

function toDriveAccount(row: DbAccount): DriveAccount {
  let credential: DriveAccount['credential'] = {}
  try {
    credential = JSON.parse(decryptCredential(row.encrypted_credential))
  } catch (err) {
    log.warn(`Unable to decrypt account ${row.id} during health check:`, String(err))
  }
  return {
    id: row.id,
    platform: row.platform as DriveAccount['platform'],
    nickname: row.nickname || row.id,
    loginType: row.login_type as DriveAccount['loginType'],
    credential,
    userAgent: row.user_agent || undefined,
    status: row.status as DriveAccount['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckAt: row.last_check_at || undefined,
  }
}

function showMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) attachMainWindow(createMainWindow())
  if (mainWindow!.isMinimized()) mainWindow!.restore()
  mainWindow!.show()
  mainWindow!.focus()
  return mainWindow!
}

function attachMainWindow(window: BrowserWindow): void {
  mainWindow = window
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
}

function startBackgroundServices(): void {
  trayNotifications = createTrayNotificationManager({
    getWindow: () => mainWindow,
    onShowWindow: () => { showMainWindow() },
    onOpenTasks: () => showMainWindow().webContents.send(IPC_CHANNELS.APP_NAVIGATE, '/tasks'),
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
  })
  trayNotifications.start()
  setTrayNotificationManager(trayNotifications)

  const configuredMinutes = Number(getSetting('account_health_interval_minutes')?.value || 15)
  healthScheduler = createAccountHealthScheduler<DriveAccount>({
    getAccounts: () => getAllAccounts().map(toDriveAccount),
    checkAccount: async (account, signal) => {
      signal.throwIfAborted()
      const active = await getAdapter(account.platform).checkLogin(account)
      signal.throwIfAborted()
      return active ? 'active' : 'expired'
    },
    onAccountChecked: ({ account, status, checkedAt }) => {
      updateAccountStatus(account.id, status, checkedAt)
    },
    onStatusChange: ({ account, status }) => {
      if (status === 'expired') {
        trayNotifications?.notifyAccountExpired({ id: account.id, nickname: account.nickname, platform: account.platform })
      }
    },
    onError: ({ phase, accountId, error }) => {
      log.warn(`Account health ${phase}${accountId ? ` (${accountId})` : ''}:`, String(error))
    },
    intervalMs: Math.max(5, Number.isFinite(configuredMinutes) ? configuredMinutes : 15) * 60_000,
    concurrency: 2,
  })
  healthScheduler.start()
}

// SQLite and the persistent task queue are single-writer resources. Keep one
// application process and focus the existing window when PanLite is launched
// again.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  showMainWindow()
})

function cleanupLegacyArchiveTempDirs(): void {
  const tempRoot = resolve(tmpdir())
  for (const name of ['panlite-archive', 'panlite-archive-extract', 'panlite-compress']) {
    const target = resolve(tempRoot, name)
    if (dirname(target) !== tempRoot) continue
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (err) {
      log.warn(`Failed to clean temporary directory ${name}:`, String(err))
    }
  }
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  log.info('PanLite starting...')
  cleanupLegacyArchiveTempDirs()

  // Initialize SQLite database
  initDatabase()
  log.info('Database initialized')

  // Register IPC handlers
  registerIpcHandlers()
  log.info('IPC handlers registered')

  // Resume any pending tasks from previous session
  resumePendingTasks()

  // Create main window
  attachMainWindow(createMainWindow())
  log.info('Main window created')
  startBackgroundServices()
}).catch((err) => {
  log.error('PanLite failed to start:', err)
  dialog.showErrorBox('PanLite 启动失败', `初始化失败，请检查日志。\n\n${String(err)}`)
  app.quit()
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  healthScheduler?.dispose()
  healthScheduler = null
  disposeRuntimeServices()
  cleanupIpcResources()
  trayNotifications = null
})

app.on('activate', () => {
  if (mainWindow === null) {
    attachMainWindow(createMainWindow())
  }
  showMainWindow()
})
