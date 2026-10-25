import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { configureShareWebview } from './share-webview'
import { getShareBrowserUrl } from '../shared/share-browser'

function setup() {
  const handlers = new Map<string, (event: { preventDefault: () => void }, url: string) => void>()
  const guest = { loadURL: vi.fn().mockResolvedValue(undefined), setWindowOpenHandler: vi.fn(),
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    session: { setPermissionRequestHandler: vi.fn() } }
  configureShareWebview(guest as unknown as WebContents)
  return { guest, handlers, open: guest.setWindowOpenHandler.mock.calls[0][0] }
}

describe('inline share navigation', () => {
  it('opens target=_blank in the same guest and denies a new window', async () => {
    const { guest, open } = setup()
    expect(open({ url: 'https://pan.quark.cn/s/abc?pwd=a1B2' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledWith('https://pan.quark.cn/s/abc?pwd=a1B2')
    guest.loadURL.mockRejectedValueOnce(new Error('offline'))
    open({ url: 'https://pan.baidu.com/s/1abc' })
    await Promise.resolve()
  })
  it('keeps HTTP(S) redirects in the guest and blocks privileged/app protocols', () => {
    const { handlers, guest, open } = setup()
    for (const name of ['will-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn() }
      handlers.get(name)!(event, 'https://passport.example.test/login')
      expect(event.preventDefault).not.toHaveBeenCalled()
      for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'xunlei://download', 'https://user:pass@example.com/']) {
        handlers.get(name)!(event, url)
        expect(open({ url })).toEqual({ action: 'deny' })
      }
      expect(event.preventDefault).toHaveBeenCalledTimes(4)
    }
    expect(guest.loadURL).not.toHaveBeenCalled()
  })
  it('does not grant native permissions to the share page', () => {
    const { guest } = setup()
    const callback = vi.fn()
    guest.session.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
  it('preserves query strings and extraction-code fragments while rejecting malformed URLs', () => {
    expect(getShareBrowserUrl(' https://www.alipan.com/s/abc#A1b2 ')).toBe('https://www.alipan.com/s/abc#A1b2')
    for (const value of [null, undefined, '', 'not a URL', 'data:text/html,evil']) expect(getShareBrowserUrl(value)).toBeNull()
  })
})
