import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
const mocks = vi.hoisted(() => ({ events: new Map<string, (...args: any[]) => void>(), timeline: [] as string[],
  openExternal: vi.fn(), shareSession: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() } }))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }, nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: mocks.openExternal }, session: { fromPartition: () => mocks.shareSession },
  BrowserWindow: class {
    constructor() { mocks.timeline.push('window') }
    webContents = { on: (name: string, listener: (...args: any[]) => void) => mocks.events.set(name, listener), setWindowOpenHandler: vi.fn(), openDevTools: vi.fn() }
    removeMenu() {} loadFile() {} loadURL() {}
  },
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), error: vi.fn() } }))
import { createMainWindow } from './window'
import { SHARE_BROWSER_PARTITION } from '../shared/share-browser'
afterEach(() => { mocks.events.clear(); mocks.timeline.length = 0; vi.resetAllMocks() })

describe('share guest attachment', () => {
  it('denies share-session permissions before creating the main window', () => {
    mocks.shareSession.setPermissionCheckHandler.mockImplementation(() => { mocks.timeline.push('check') })
    mocks.shareSession.setPermissionRequestHandler.mockImplementation(() => { mocks.timeline.push('request') })
    createMainWindow()
    expect(mocks.timeline).toEqual(['check', 'request', 'window'])
  })
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
    const guest = { session: { setPermissionRequestHandler: vi.fn() }, setWindowOpenHandler: vi.fn(), on: vi.fn() }
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
  it('keeps a resource guest origin when a share guest attaches between its events', () => {
    createMainWindow()
    const willAttach = mocks.events.get('will-attach-webview')!
    const didAttach = mocks.events.get('did-attach-webview')!
    willAttach({ preventDefault: vi.fn() }, {}, { src: 'https://resource.example.test/file', partition: '' })
    willAttach({ preventDefault: vi.fn() }, {}, { src: 'https://pan.quark.cn/s/abc', partition: SHARE_BROWSER_PARTITION })
    const shareGuest = { session: mocks.shareSession, setWindowOpenHandler: vi.fn(), on: vi.fn() }
    didAttach({}, shareGuest)
    const resourceGuest = { session: { setPermissionRequestHandler: vi.fn() }, setWindowOpenHandler: vi.fn(), on: vi.fn() }
    didAttach({}, resourceGuest)
    const navigate = resourceGuest.on.mock.calls.find(call => call[0] === 'will-navigate')![1]
    const sameOrigin = { preventDefault: vi.fn() }
    navigate(sameOrigin, 'https://resource.example.test/other-file')
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()
    const otherOrigin = { preventDefault: vi.fn() }
    navigate(otherOrigin, 'https://other.example.test/file')
    expect(otherOrigin.preventDefault).toHaveBeenCalledOnce()
  })
  it('does not leave a queued origin when a share attachment is canceled', () => {
    createMainWindow()
    const willAttach = mocks.events.get('will-attach-webview')!
    const didAttach = mocks.events.get('did-attach-webview')!
    willAttach({ preventDefault: vi.fn() }, {}, { src: 'https://pan.quark.cn/s/canceled', partition: SHARE_BROWSER_PARTITION })
    // There is no did-attach-webview for the canceled share guest.
    willAttach({ preventDefault: vi.fn() }, {}, { src: 'https://resource.example.test/file', partition: '' })
    const resourceGuest = { session: { setPermissionRequestHandler: vi.fn() }, setWindowOpenHandler: vi.fn(), on: vi.fn() }
    didAttach({}, resourceGuest)
    const navigate = resourceGuest.on.mock.calls.find(call => call[0] === 'will-navigate')![1]
    const sameOrigin = { preventDefault: vi.fn() }
    navigate(sameOrigin, 'https://resource.example.test/other-file')
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()
  })
})
