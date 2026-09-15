import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrayNotificationManager } from './tray-notifications'

const mocks = vi.hoisted(() => ({ notifications: [] as any[], menus: [] as any[], supported: true }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { quit: vi.fn() },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    Menu: { buildFromTemplate: (menu: unknown) => { mocks.menus.push(menu); return menu } },
    Tray: class extends EventEmitter {
      destroyed = false
      isDestroyed() { return this.destroyed }
      setToolTip() {}
      setContextMenu() {}
      destroy() { this.destroyed = true }
    },
    Notification: class extends EventEmitter {
      static isSupported() { return mocks.supported }
      show = vi.fn()
      close = vi.fn()
      constructor(public options: unknown) { super(); mocks.notifications.push(this) }
    },
  }
})

let manager: TrayNotificationManager
const openTasks = vi.fn()
const showWindow = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
  mocks.notifications.length = 0
  mocks.menus.length = 0
  mocks.supported = true
  openTasks.mockReset()
  showWindow.mockReset()
  manager = new TrayNotificationManager({ getWindow: () => null, onOpenTasks: openTasks, onShowWindow: showWindow, throttleMs: 100, dedupeWindowMs: 500 })
})
afterEach(() => { manager.dispose(); vi.clearAllTimers(); vi.useRealTimers() })

describe('tray and task notification behavior', () => {
  it('provides task navigation and releases native resources on shutdown', () => {
    const tray = manager.start()
    mocks.menus[0].find((item: { label: string }) => item.label === '任务页').click()
    expect(showWindow).toHaveBeenCalledOnce()
    expect(openTasks).toHaveBeenCalledOnce()
    manager.notifyTask({ id: 'success', title: 'fixture', status: 'success' })
    manager.stop()
    expect(tray.isDestroyed()).toBe(true)
    expect(mocks.notifications[0].close).toHaveBeenCalledOnce()
  })

  it('distinguishes partial completion, deduplicates updates and throttles successive tasks', async () => {
    expect(manager.notifyTask({ id: 'one', title: 'fixture', status: 'partial_success' })).toBe('shown')
    expect(mocks.notifications[0].options.title).toContain('部分完成')
    expect(manager.notifyTask({ id: 'one', title: 'fixture', status: 'partial_success' })).toBe('duplicate')
    expect(manager.notifyTask({ id: 'two', title: 'fixture', status: 'failed', errorMessage: 'fixture error' })).toBe('queued')
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.notifications).toHaveLength(2)
    expect(mocks.notifications[1].options.body).toBe('fixture error')
    mocks.notifications[1].emit('click')
    expect(showWindow).toHaveBeenCalledOnce()
  })

  it('drops queued notifications while paused and resumes new notifications', async () => {
    manager.notifyTask({ id: 'one', title: 'fixture', status: 'success' })
    manager.notifyTask({ id: 'two', title: 'fixture', status: 'success' })
    manager.setNotificationsPaused(true)
    expect(manager.notifyAccountExpired({ id: 'account', nickname: 'fixture', platform: 'quark' })).toBe('paused')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.notifications).toHaveLength(1)
    manager.setNotificationsPaused(false)
    expect(manager.notifyAccountExpired({ id: 'account', nickname: 'fixture', platform: 'quark' })).toBe('shown')
  })

  it('does not create notifications when the runtime does not support them', () => {
    mocks.supported = false
    expect(manager.notifyTask({ id: 'one', title: 'fixture', status: 'success' })).toBe('unsupported')
    expect(mocks.notifications).toHaveLength(0)
  })
})
