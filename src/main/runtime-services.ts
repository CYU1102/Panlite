import type { TaskNotificationInput, TrayNotificationManager } from './tray-notifications'
import { BrowserWindow } from 'electron'
import type { AiProviderConfig } from '../shared/ai-types'
import { IPC_CHANNELS } from '../shared/constants'
import { isTrustedRendererUrl } from './ipc-security'

let trayNotifications: TrayNotificationManager | null = null

export function setTrayNotificationManager(manager: TrayNotificationManager | null): void {
  trayNotifications = manager
}

export function notifyTaskTerminal(task: TaskNotificationInput): void {
  try {
    trayNotifications?.notifyTask(task)
  } catch {
    // Notifications must never affect task completion.
  }
}

export function notifyAiProviderChanged(config: AiProviderConfig): void {
  try {
    trayNotifications?.rebuildMenu()
  } catch {
    // A failed menu refresh must not turn a persisted save into an apparent failure.
  }
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && isTrustedRendererUrl(window.webContents.getURL())) {
        window.webContents.send(IPC_CHANNELS.AI_PROVIDER_CHANGED, config)
      }
    } catch {
      // A closing window must not prevent the other windows from receiving updates.
    }
  }
}

export function disposeRuntimeServices(): void {
  trayNotifications?.dispose()
  trayNotifications = null
}
