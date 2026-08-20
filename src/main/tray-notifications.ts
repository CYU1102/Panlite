import {
  app,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
  type NotificationConstructorOptions,
} from 'electron'
import { join } from 'path'
import type { Platform, TaskStatus } from '../shared/types'

export type NotifiableTaskStatus = Extract<TaskStatus, 'success' | 'partial_success' | 'failed'>

export interface TaskNotificationInput {
  id: string
  title: string
  status: NotifiableTaskStatus
  errorMessage?: string
  summary?: string
}

export interface AccountExpiredNotificationInput {
  id: string
  nickname: string
  platform: Platform
}

export type NotificationDispatchResult =
  | 'shown'
  | 'queued'
  | 'duplicate'
  | 'paused'
  | 'unsupported'

export interface TrayNotificationOptions {
  getWindow: () => BrowserWindow | null
  onOpenTasks: () => void
  onShowWindow?: () => void
  onQuit?: () => void
  onNotificationsPausedChange?: (paused: boolean) => void
  trayIcon?: string | NativeImage
  tooltip?: string
  throttleMs?: number
  dedupeWindowMs?: number
  maxPending?: number
}

interface QueuedNotification {
  key: string
  options: NotificationConstructorOptions
}

const DEFAULT_THROTTLE_MS = 3_000
const DEFAULT_DEDUPE_WINDOW_MS = 60_000
const DEFAULT_MAX_PENDING = 50

function positiveInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function defaultTrayIcon(): NativeImage {
  const image = nativeImage.createFromPath(join(process.cwd(), 'build', 'icon.png'))
  return image.isEmpty() ? nativeImage.createEmpty() : image
}

export class TrayNotificationManager {
  private tray: Tray | null = null
  private paused = false
  private disposed = false
  private lastShownAt = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queue: QueuedNotification[] = []
  private readonly dedupe = new Map<string, number>()
  private readonly activeNotifications = new Set<Notification>()
  private readonly throttleMs: number
  private readonly dedupeWindowMs: number
  private readonly maxPending: number

  constructor(private readonly options: TrayNotificationOptions) {
    this.throttleMs = positiveInteger(options.throttleMs, DEFAULT_THROTTLE_MS, 0)
    this.dedupeWindowMs = positiveInteger(options.dedupeWindowMs, DEFAULT_DEDUPE_WINDOW_MS, 1)
    this.maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING, 1)
  }

  start(): Tray {
    this.assertNotDisposed()
    if (this.tray && !this.tray.isDestroyed()) return this.tray

    this.tray = new Tray(this.options.trayIcon ?? defaultTrayIcon())
    this.tray.setToolTip(this.options.tooltip ?? 'PanLite')
    this.tray.on('click', this.showWindow)
    this.rebuildMenu()
    return this.tray
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.queue.length = 0
    this.dedupe.clear()
    this.lastShownAt = 0

    for (const notification of this.activeNotifications) {
      notification.removeAllListeners()
      notification.close()
    }
    this.activeNotifications.clear()

    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.removeListener('click', this.showWindow)
      this.tray.destroy()
    }
    this.tray = null
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
  }

  rebuildMenu(): void {
    if (!this.tray || this.tray.isDestroyed()) return

    const template: MenuItemConstructorOptions[] = [
      {
        label: '显示窗口',
        click: this.showWindow,
      },
      {
        label: '任务页',
        click: () => {
          this.showWindow()
          this.options.onOpenTasks()
        },
      },
      { type: 'separator' },
      {
        label: '暂停通知',
        type: 'checkbox',
        checked: this.paused,
        click: (menuItem) => this.setNotificationsPaused(menuItem.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => (this.options.onQuit ?? (() => app.quit()))(),
      },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  setNotificationsPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused

    if (paused) {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = null
      this.queue.length = 0
      this.dedupe.clear()
    }

    this.rebuildMenu()
    this.options.onNotificationsPausedChange?.(paused)
  }

  areNotificationsPaused(): boolean {
    return this.paused
  }

  notifyTask(task: TaskNotificationInput): NotificationDispatchResult {
    const content = this.taskNotificationContent(task)
    return this.enqueue(`task:${task.id}:${task.status}`, content)
  }

  notifyAccountExpired(account: AccountExpiredNotificationInput): NotificationDispatchResult {
    return this.enqueue(`account:${account.id}:expired`, {
      title: `${account.nickname} 登录已过期`,
      body: `${account.platform} 账号凭据已失效，请重新登录。`,
      timeoutType: 'default',
    })
  }

  private readonly showWindow = (): void => {
    if (this.options.onShowWindow) {
      this.options.onShowWindow()
      return
    }

    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private taskNotificationContent(task: TaskNotificationInput): NotificationConstructorOptions {
    if (task.status === 'success') {
      return {
        title: `${task.title} 已完成`,
        body: task.summary || '任务执行成功。',
        timeoutType: 'default',
      }
    }
    if (task.status === 'partial_success') {
      return {
        title: `${task.title} 部分完成`,
        body: task.summary || task.errorMessage || '部分项目执行失败，请前往任务页查看详情。',
        timeoutType: 'default',
      }
    }
    return {
      title: `${task.title} 执行失败`,
      body: task.errorMessage || task.summary || '请前往任务页查看错误详情并重试。',
      timeoutType: 'default',
    }
  }

  private enqueue(key: string, options: NotificationConstructorOptions): NotificationDispatchResult {
    this.assertNotDisposed()
    if (this.paused) return 'paused'
    if (!Notification.isSupported()) return 'unsupported'

    const currentTime = Date.now()
    this.pruneDedupe(currentTime)
    const previous = this.dedupe.get(key)
    if (previous !== undefined && currentTime - previous < this.dedupeWindowMs) return 'duplicate'
    this.dedupe.set(key, currentTime)

    if (!this.flushTimer && this.queue.length === 0 && currentTime - this.lastShownAt >= this.throttleMs) {
      this.showNotification(options)
      return 'shown'
    }

    if (this.queue.length >= this.maxPending) {
      const dropped = this.queue.shift()
      if (dropped) this.dedupe.delete(dropped.key)
    }
    this.queue.push({ key, options })
    this.scheduleFlush(currentTime)
    return 'queued'
  }

  private scheduleFlush(currentTime = Date.now()): void {
    if (this.flushTimer || this.paused || this.queue.length === 0) return
    const delay = Math.max(0, this.throttleMs - (currentTime - this.lastShownAt))
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.paused) return
      const next = this.queue.shift()
      if (!next) return
      this.showNotification(next.options)
      this.scheduleFlush()
    }, delay)
  }

  private showNotification(options: NotificationConstructorOptions): void {
    try {
      const notification = new Notification(options)
      const release = () => this.activeNotifications.delete(notification)
      notification.once('click', this.showWindow)
      notification.once('close', release)
      notification.once('failed', release)
      this.activeNotifications.add(notification)
      notification.show()
      this.lastShownAt = Date.now()
    } catch {
      this.lastShownAt = Date.now()
    }
  }

  private pruneDedupe(currentTime: number): void {
    for (const [key, timestamp] of this.dedupe) {
      if (currentTime - timestamp >= this.dedupeWindowMs) this.dedupe.delete(key)
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('TrayNotificationManager has been disposed')
  }
}

export function createTrayNotificationManager(options: TrayNotificationOptions): TrayNotificationManager {
  return new TrayNotificationManager(options)
}
