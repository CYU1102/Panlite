import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ windows: [] as any[], options: [] as any[] }))
vi.mock('electron', () => ({ BrowserWindow: class {
  destroyed = false
  listener: ((details: any) => Promise<void>) | null = null
  loadURL = vi.fn(() => new Promise(() => {}))
  isDestroyed = () => this.destroyed
  destroy = vi.fn(() => { this.destroyed = true })
  webContents = {
    executeJavaScript: vi.fn(async () => ''),
    session: { webRequest: { onCompleted: vi.fn((filter: unknown, listener: ((details: any) => Promise<void>) | null) => { this.listener = filter === null ? null : listener }) } },
  }
  constructor(options: unknown) { mocks.windows.push(this); mocks.options.push(options) }
} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { searchWithBrowser } from './browser-crawler'
import { withSearchSignal } from './search-runtime'
beforeEach(() => { mocks.windows.length = 0; mocks.options.length = 0 })
const source = { name: 'Fixture', url: 'https://fixture.invalid/', platform: 'quark' }

describe('browser crawler lifecycle', () => {
  it('isolates crawler sessions and destroys loading windows on cancellation', async () => {
    const controller = new AbortController()
    const searches = [1, 2].map(() => withSearchSignal(controller.signal, () => searchWithBrowser(source, 'keyword')))
    expect(mocks.windows).toHaveLength(2)
    const partitions = mocks.options.map(option => option.webPreferences.partition)
    expect(new Set(partitions).size).toBe(2)
    expect(partitions.every(partition => partition.startsWith('panlite-crawler-'))).toBe(true)
    controller.abort()
    expect(await Promise.all(searches)).toEqual([[], []])
    for (const win of mocks.windows) {
      expect(win.destroy).toHaveBeenCalledOnce()
      expect(win.listener).toBeNull()
    }
  })

  it('replays each XHR URL once and serializes quotes in the URL safely', async () => {
    const controller = new AbortController()
    const pending = withSearchSignal(controller.signal, () => searchWithBrowser(source, 'keyword'))
    const win = mocks.windows[0]
    const details = { resourceType: 'xhr', statusCode: 200, url: "https://fixture.invalid/api?q='quoted'" }
    await win.listener(details)
    await win.listener(details)
    expect(win.webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(win.webContents.executeJavaScript.mock.calls[0][0]).toContain(`xhr.open('GET', ${JSON.stringify(details.url)}, true)`)
    controller.abort()
    await pending
  })
})
