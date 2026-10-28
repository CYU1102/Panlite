import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
const mocks = vi.hoisted(() => ({ events: new Map<string, (...args: any[]) => void>(),
  openExternal: vi.fn(), options: vi.fn(), allowsLogin: vi.fn(), attachLogin: vi.fn(), isLoginSession: vi.fn(), configureResource: vi.fn(),
  resourceSession: { setPermissionRequestHandler: vi.fn() }, shareSession: { setPermissionRequestHandler: vi.fn() } }))
vi.mock('./inline-login', () => ({ inlineLoginManager: { allowsAttachment: mocks.allowsLogin, attach: mocks.attachLogin, isLoginSession: mocks.isLoginSession } }))
vi.mock('./resource-webview', () => ({ configureResourceWebview: mocks.configureResource }))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }, nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: mocks.openExternal }, session: { fromPartition: (name: string) => name === 'panlite-share-browser' ? mocks.shareSession : mocks.resourceSession },
  BrowserWindow: class {
    constructor(options: unknown) { mocks.options(options) }
    webContents = { on: (name: string, listener: (...args: any[]) => void) => mocks.events.set(name, listener), setWindowOpenHandler: vi.fn(), openDevTools: vi.fn() }
    removeMenu() {} loadFile() {} loadURL() {}
  },
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), error: vi.fn() } }))
import { createMainWindow } from './window'
import { SHARE_BROWSER_PARTITION } from '../shared/share-browser'
afterEach(() => { mocks.events.clear(); vi.resetAllMocks() })

describe('share guest attachment', () => {
  it('strips preloads, retains sandboxing, and installs in-page popup handling', () => {
    createMainWindow()
    const preferences: Record<string, unknown> = { preload: 'file:///untrusted.js', nodeIntegration: true, sandbox: false }
    const event = { preventDefault: vi.fn() }
    mocks.events.get('will-attach-webview')!(event, preferences, { src: 'https://pan.quark.cn/s/abc', partition: SHARE_BROWSER_PARTITION })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false })
    expect(preferences.preload).toBeUndefined()
    const guest = { session: mocks.shareSession, setWindowOpenHandler: vi.fn(), on: vi.fn(), loadURL: vi.fn().mockResolvedValue(undefined) }
    mocks.events.get('did-attach-webview')!({}, guest as unknown as WebContents)
    const open = guest.setWindowOpenHandler.mock.calls[0][0]
    expect(open({ url: 'https://passport.example.test/login' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledWith('https://passport.example.test/login')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
  it('keeps the existing resource-browser extraction preload and origin policy', () => {
    createMainWindow()
    const preferences: Record<string, unknown> = {}
    mocks.events.get('will-attach-webview')!({ preventDefault: vi.fn() }, preferences, { src: 'https://example.test/', partition: '' })
    expect(preferences.preload).toMatch(/preload-extract\.js$/)
    const guest = { session: mocks.resourceSession, setWindowOpenHandler: vi.fn(), on: vi.fn() }
    mocks.events.get('did-attach-webview')!({}, guest)
    const navigate = guest.on.mock.calls.find(call => call[0] === 'will-navigate')![1]
    const event = { preventDefault: vi.fn() }
    navigate(event, 'https://other.example.test/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openExternal).toHaveBeenCalledWith('https://other.example.test/')
  })
  it('rejects non-web share guests before attachment', () => {
    createMainWindow()
    const event = { preventDefault: vi.fn() }
    mocks.events.get('will-attach-webview')!(event, {}, { src: 'file:///C:/secret', partition: SHARE_BROWSER_PARTITION })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
  it('only attaches an owner-approved inline login with no preload', () => {
    createMainWindow(); mocks.allowsLogin.mockReturnValue(true); mocks.attachLogin.mockReturnValue(true); mocks.isLoginSession.mockReturnValue(true)
    const preferences: Record<string, unknown> = { preload: 'file:///untrusted.js' }
    const event = { preventDefault: vi.fn() }
    mocks.events.get('will-attach-webview')!(event, preferences, { src: 'https://pan.quark.cn/', partition: 'panlite-inline-login-fixture' })
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(preferences.preload).toBeUndefined()
    const guest = { session: {}, close: vi.fn(), setWindowOpenHandler: vi.fn() }
    mocks.events.get('did-attach-webview')!({}, guest)
    expect(mocks.attachLogin).toHaveBeenCalledWith(expect.anything(), guest)
    expect(guest.setWindowOpenHandler).not.toHaveBeenCalled()
    mocks.allowsLogin.mockReturnValue(false)
    mocks.events.get('will-attach-webview')!(event, {}, { src: 'https://pan.quark.cn/', partition: 'panlite-inline-login-forged' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
  it('closes a login guest whose session was cancelled during attachment', () => {
    createMainWindow(); mocks.allowsLogin.mockReturnValue(true); mocks.attachLogin.mockReturnValue(false); mocks.isLoginSession.mockReturnValue(true)
    mocks.events.get('will-attach-webview')!({ preventDefault: vi.fn() }, {}, { src: 'https://drive.uc.cn/', partition: 'panlite-inline-login-cancelled' })
    const guest = { close: vi.fn() }
    mocks.events.get('did-attach-webview')!({}, guest)
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })
  it('binds an approved resource session to its actual guest and clears the captured session after detach', () => {
    createMainWindow()
    mocks.events.get('will-attach-webview')!({ preventDefault: vi.fn() }, {}, { src: 'https://source.example.test/', partition: 'panlite-resource-browser-fixture' })
    const ses = Object.assign(mocks.resourceSession, { clearStorageData: vi.fn().mockResolvedValue(undefined), clearCache: vi.fn().mockResolvedValue(undefined) })
    const guest = { session: ses, once: vi.fn() }
    mocks.events.get('did-attach-webview')!({}, guest)
    expect(mocks.configureResource).toHaveBeenCalledWith(expect.anything(), guest, 'https://source.example.test', expect.any(Function), expect.any(Function))
    const cleanup = guest.once.mock.calls.find(call => call[0] === 'destroyed')![1]
    Object.defineProperty(guest, 'session', { get: () => { throw new Error('Destroyed guest') } })
    expect(() => cleanup()).not.toThrow()
    expect(ses.clearStorageData).toHaveBeenCalledOnce()
  })
  it('keeps startup benchmarks hidden while normal launches remain visible', () => {
    const original = process.argv
    try {
      process.argv = [...original, '--benchmark-startup']; createMainWindow()
      expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ show: false }))
      process.argv = original.filter(arg => arg !== '--benchmark-startup'); createMainWindow()
      expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ show: true }))
      expect(mocks.events.has('ready-to-show')).toBe(false)
    } finally { process.argv = original }
  })
  it.runIf(process.platform === 'win32')('shows only an explicitly authorized hosted benchmark window', () => {
    const original = process.argv
    try {
      for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
        RUNNER_TEMP: 'temporary', GITHUB_WORKSPACE: 'workspace', GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40) })) vi.stubEnv(key, value)
      process.argv = [...original, '--benchmark-startup', '--benchmark-visible']
      createMainWindow()
      expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({ show: true, webPreferences: expect.objectContaining({ backgroundThrottling: false }) }))
      vi.stubEnv('RUNNER_ENVIRONMENT', 'self-hosted')
      expect(() => createMainWindow()).toThrow(/disposable GitHub-hosted Windows runner/)
    } finally { process.argv = original; vi.unstubAllEnvs() }
  })
})
