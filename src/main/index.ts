import { app, BrowserWindow, dialog, nativeTheme, protocol } from 'electron'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import log from 'electron-log'
import { createMainWindow } from './window'
import { getAllAccounts, getSetting, setSetting, initDatabase, updateAccountStatus, type DbAccount } from './db'
import { cleanupIpcResources, registerIpcHandlers } from './ipc'
import { resumePendingTasks } from './task-runner'
import { decryptCredential } from './crypto'
import { getAdapter } from '../adapters/registry'
import type { DriveAccount } from '../shared/types'
import { createTrayNotificationManager, type TrayNotificationManager } from './tray-notifications'
import { createAccountHealthScheduler, type AccountHealthScheduler } from './account-health'
import { disposeRuntimeServices, setTrayNotificationManager, notifyAiProviderChanged } from './runtime-services'
import { createLogSanitizer } from './log-sanitizer'
import { initClipboardMonitor } from './clipboard-monitor'
import { getShareSubscriptionScheduler, initShareSubscriptionScheduler } from './share-subscriptions'
import { registerTaskExtension } from './task-extensions'
import { initGlobalShortcuts, releaseGlobalShortcuts, setGlobalShortcutsEnabled } from './global-shortcuts'
import { activateAiProviderProfile, listAiProviderProfiles } from './ai/ai-provider-store'
import { getAiProviderConfig } from './ai/ai-provider'
import { CLIPBOARD_MONITOR_DEFAULT_ENABLED, IPC_CHANNELS } from '../shared/constants'
import { createStartupBenchmark } from './startup-benchmark'
import { handleFilePreviewRequest } from './ipc/files'
import { recoverCatalogScans } from './catalog-runtime'
import { getAppSnapshotService, processPendingAppSnapshots } from './app-snapshot-runtime'
import { AppSnapshotError } from './app-snapshot-service'
import { startAutomationRules } from './automation-rule-runtime'
import { recoverFileBackupJobs } from './file-backup-runtime'

protocol.registerSchemesAsPrivileged([{ scheme: 'panlite-preview', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }])

const startupBenchmark = createStartupBenchmark()

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
let startupReady = false

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
    getAiProfiles: () => listAiProviderProfiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      model: profile.model,
      active: profile.id === getAiProviderConfig().id,
    })),
    onActivateAiProfile: (id) => {
      try {
        const config = activateAiProviderProfile(id)
        showMainWindow().webContents.send(IPC_CHANNELS.APP_NAVIGATE, '/ai-workspace')
        notifyAiProviderChanged(config)
        log.info(`AI provider switched to ${config.name} from tray`)
      } catch (error) {
        log.warn('Failed to activate AI provider from tray:', String(error))
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
  })
  trayNotifications.start()
  setTrayNotificationManager(trayNotifications)

  const clipboardMonitor = initClipboardMonitor({
    getWindow: () => mainWindow,
    onDetect: (payload) => {
      showMainWindow().webContents.send(IPC_CHANNELS.CLIPBOARD_SHARE_DETECTED, payload)
    },
  })
  const clipboardEnabled = getSetting('clipboardMonitorEnabled')?.value
  if ((clipboardEnabled ?? String(CLIPBOARD_MONITOR_DEFAULT_ENABLED)) !== 'false') clipboardMonitor.start()

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

  initGlobalShortcuts({
    toggleWindow: () => {
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
      else showMainWindow()
    },
    navigateTo: (path) => showMainWindow().webContents.send(IPC_CHANNELS.APP_NAVIGATE, path),
  })
  const savedShortcuts = getSetting('globalShortcutsEnabled')?.value
  if ((savedShortcuts ?? 'true') !== 'false') setGlobalShortcutsEnabled(true)

  initShareSubscriptionScheduler({
    onSynced: ({ title, savedCount }) => {
      trayNotifications?.notifyTask({ id: `subscription-${Date.now()}`, title: `订阅更新：${title}`, status: 'success', summary: `已保存 ${savedCount} 个条目` })
    },
    onFailed: ({ title, error }) => {
      trayNotifications?.notifyTask({ id: `subscription-${Date.now()}`, title: `订阅检查失败：${title}`, status: 'failed', errorMessage: error })
    },
  })
}

// SQLite and the persistent task queue are single-writer resources. Keep one
// application process and focus the existing window when PanLite is launched
// again.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (startupReady) showMainWindow()
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

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  log.info('PanLite starting...')
  // Complete verified snapshot/restore work before any database writer starts.
  if (!startupBenchmark) await processPendingAppSnapshots()
  if (!startupBenchmark) cleanupLegacyArchiveTempDirs()

  // Initialize SQLite database
  initDatabase()
  if (startupBenchmark?.theme) setSetting('theme', startupBenchmark.theme)
  log.info('Database initialized')

  // Register IPC handlers
  registerIpcHandlers()
  protocol.handle('panlite-preview', handleFilePreviewRequest)
  log.info('IPC handlers registered')

  // 原生菜单栏/标题栏跟随应用主题（设置页和顶栏切换时经 SETTINGS_SET 同步到这里）
  const savedTheme = getSetting('theme')?.value
  nativeTheme.themeSource = savedTheme === 'dark' ? 'dark' : 'light'

  registerTaskExtension('subscription_sync', context => {
    const scheduler = getShareSubscriptionScheduler() ?? initShareSubscriptionScheduler({
      onSynced: ({ title, savedCount }) => trayNotifications?.notifyTask({ id: `subscription-${Date.now()}`, title: `订阅更新：${title}`, status: 'success', summary: `已保存 ${savedCount} 个条目` }),
      onFailed: ({ title, error }) => trayNotifications?.notifyTask({ id: `subscription-${Date.now()}`, title: `订阅检查失败：${title}`, status: 'failed', errorMessage: error }),
    })
    return scheduler.execute(context)
  })
  // Resume any pending tasks from previous session
  await recoverFileBackupJobs()
  resumePendingTasks()

  // Create main window
  startupReady = true
  attachMainWindow(createMainWindow())
  log.info('Main window created')
  if (startupBenchmark) startupBenchmark.recordWindow(mainWindow!)
  else {
    startBackgroundServices()
    startAutomationRules()
    void recoverCatalogScans().catch(() => log.warn('文件目录扫描恢复失败，可在文件目录页重试'))
  }
}).catch(async (err) => {
  log.error('PanLite failed to start:', err)
  if (startupBenchmark) {
    app.exit(1)
    return
  }
  if (!startupReady && err instanceof AppSnapshotError) {
    const service = getAppSnapshotService(), pending = await service.getPendingOperation()
    const canCancel = pending.success && pending.pending?.canCancel === true
    const answer = await dialog.showMessageBox({ type: 'error', title: '应用快照未完成', message: err.message,
      detail: canCancel ? '原有应用数据尚可使用。可以取消本次请求并重新启动，稍后从备份页重试。'
        : '恢复尚未完成，当前不会打开应用数据。原始文件和回滚快照已保留，下次启动将继续处理。',
      buttons: canCancel ? ['取消请求并重新启动', '退出'] : ['退出'], defaultId: canCancel ? 1 : 0, cancelId: canCancel ? 1 : 0 })
    if (canCancel && answer.response === 0 && (await service.cancelPendingOperation()).success) app.relaunch()
    app.quit(); return
  }
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
  getShareSubscriptionScheduler()?.stop()
  releaseGlobalShortcuts()
  healthScheduler?.dispose()
  healthScheduler = null
  disposeRuntimeServices()
  cleanupIpcResources()
  trayNotifications = null
})

app.on('activate', () => {
  if (!startupReady) return
  if (mainWindow === null) {
    attachMainWindow(createMainWindow())
  }
  showMainWindow()
})
