import type { TaskNotificationInput, TrayNotificationManager } from './tray-notifications'

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

export function disposeRuntimeServices(): void {
  trayNotifications?.dispose()
  trayNotifications = null
}
