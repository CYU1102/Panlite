import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/constants'
const runtime = vi.hoisted(() => ({ packaged: true, policy: {} as any, feed: '', updater: null as any,
  read: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({ app: { get isPackaged() { return runtime.packaged }, getAppPath: () => '/fixture' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: runtime.send } }] },
  dialog: { showMessageBox: vi.fn() } }))
vi.mock('node:fs', () => ({ readFileSync: (path: string) => path.endsWith('package.json')
  ? JSON.stringify({ panliteUpdates: runtime.policy }) : runtime.feed }))
vi.mock('electron-log', () => ({ default: { error: vi.fn() } }))
vi.mock('../db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }) }) }))
vi.mock('electron-updater', () => ({ default: { get autoUpdater() { runtime.read(); return runtime.updater } } }))
import { registerAppUpdateIpcHandlers } from './app-update'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'win32', resourcesPath: '/fixture/resources' })
  runtime.packaged = true
  runtime.policy = { enabled: true, provider: 'github', owner: 'CYU1102', repo: 'Panlite', publisher: 'Fixture' }
  runtime.feed = 'provider: github\nowner: CYU1102\nrepo: Panlite\npublisherName: Fixture\n'
  runtime.updater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => {
    runtime.updater.emit('update-not-available'); return {}
  }) })
})

async function call(channel: string) {
  const handlers = new Map<string, (...args: any[]) => any>()
  registerAppUpdateIpcHandlers({ handle: (name, handler) => { handlers.set(name, handler) } })
  try { return await handlers.get(channel)!() } finally { vi.unstubAllGlobals() }
}

it('initializes the CommonJS default export with manual download and installation', async () => {
  const result = await call(IPC_CHANNELS.APP_UPDATE_CHECK)
  expect(result.state.phase).toBe('current')
  expect(runtime.updater.autoDownload).toBe(false)
  expect(runtime.updater.autoInstallOnAppQuit).toBe(false)
  expect(runtime.updater.allowDowngrade).toBe(false)
  expect(runtime.updater.disableWebInstaller).toBe(true)
})
it('never initializes the updater for ordinary smoke builds', async () => {
  runtime.policy.enabled = false
  expect((await call(IPC_CHANNELS.APP_UPDATE_STATUS)).phase).toBe('disabled')
  expect(runtime.read).not.toHaveBeenCalled()
})
it('never initializes the updater when publisher verification is missing', async () => {
  runtime.feed = 'provider: github\nowner: CYU1102\nrepo: Panlite\n'
  expect((await call(IPC_CHANNELS.APP_UPDATE_STATUS)).phase).toBe('disabled')
  expect(runtime.read).not.toHaveBeenCalled()
})
