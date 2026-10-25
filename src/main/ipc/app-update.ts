import { app, BrowserWindow, dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { updatesEnabled, validUpdateFeed } from '../../shared/app-update'
import { AppUpdateController } from '../app-update-controller'
import { getDb } from '../db'
import type { IpcRegistrar } from './types'

export function registerAppUpdateIpcHandlers(ipcMain: IpcRegistrar): void {
  let controller: Promise<AppUpdateController> | undefined
  const getController = () => controller ??= (async () => {
    let policy: unknown
    try { policy = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).panliteUpdates }
    catch { /* Missing policy keeps updates disabled. */ }
    let engine = null
    if (!process.argv.includes('--benchmark-startup') && updatesEnabled(app.isPackaged, process.platform, policy)) {
      const publisher = (policy as { publisher: string }).publisher
      let feed: unknown
      try { feed = load(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')) }
      catch { /* Invalid or missing feed must never bypass publisher verification. */ }
      if (!validUpdateFeed(feed, publisher)) {
        log.error('Application update feed or publisher does not match the signed-build policy')
        return new AppUpdateController(null, () => {}, () => true, async () => false)
      }
      // electron-updater exposes autoUpdater through a CommonJS getter; Node's
      // ESM namespace does not synthesize a named export for that getter.
      const { default: updaterModule } = await import('electron-updater')
      const { autoUpdater } = updaterModule
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowDowngrade = false
      autoUpdater.allowPrerelease = false
      autoUpdater.disableWebInstaller = true
      autoUpdater.logger = log
      engine = autoUpdater
    }
    return new AppUpdateController(engine, state => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.APP_UPDATE_CHANGED, state)
      }
    }, () => !!getDb().prepare("SELECT 1 FROM tasks WHERE status = 'running' LIMIT 1").get(), async () => {
      const result = await dialog.showMessageBox({ type: 'question', title: '安装更新',
        message: '安装更新将退出 PanLite，完成后重新打开。', buttons: ['取消', '安装并重启'], defaultId: 0, cancelId: 0 })
      return result.response === 1
    }, error => log.error('Application update failed:', error))
  })()
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_STATUS, async () => (await getController()).getState())
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_CHECK, async () => (await getController()).check())
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_DOWNLOAD, async () => (await getController()).download())
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_INSTALL, async () => (await getController()).install())
}
