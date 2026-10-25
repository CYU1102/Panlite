import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { configureResourceWebview } from './resource-webview'
import { getResourceShareTarget, RESOURCE_SHARE_OPEN_CHANNEL } from '../shared/resource-browser'

function fixture() {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), send: vi.fn() })
  const guest = Object.assign(new EventEmitter(), { id: 42, hostWebContents: owner, isDestroyed: vi.fn(() => false), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } })
  const trusted = vi.fn(() => true), external = vi.fn()
  const dispose = configureResourceWebview(owner as unknown as WebContents, guest as unknown as WebContents, 'https://source.example.test', trusted, external)
  cleanups.push(dispose)
  return { owner, guest, trusted, external, open: guest.setWindowOpenHandler.mock.calls[0][0] as (input: { url: string }) => { action: string } }
}
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()) })

describe('resource share handoff', () => {
  it.each([
    'https://pan.quark.cn/s/Ab12?pwd=Cd34', 'https://drive.uc.cn/s/Ab12', 'https://pan.baidu.com/s/1Ab-12',
    'https://pan.baidu.com/share/init?surl=Ab12&pwd=Cd34', 'https://pan.xunlei.com/s/Ab_12', 'https://www.alipan.com/s/Ab12', 'https://www.aliyundrive.com/s/Ab12',
  ])('routes a recognized share popup to its trusted owner: %s', url => {
    const { owner, open, external } = fixture()
    expect(open({ url })).toEqual({ action: 'deny' })
    expect(owner.send).toHaveBeenCalledWith(RESOURCE_SHARE_OPEN_CHANNEL, expect.objectContaining({ guestId: 42, url }))
    expect(external).not.toHaveBeenCalled()
  })
  it.each(['https://pan.quark.cn.evil.test/s/Ab12', 'https://evil.test/?next=https://pan.quark.cn/s/Ab12', 'https://pan.quark.cn/s/Ab12/other', 'https://pan.quark.cn:8080/s/Ab12', 'https://user:secret@pan.quark.cn/s/Ab12', 'javascript:alert(1)'])('rejects disguised/non-share URLs: %s', url => {
    expect(getResourceShareTarget(url)).toBeNull()
  })
  it.each(['will-navigate', 'will-redirect'])('captures a cross-origin share on %s and retains normal same-origin navigation', eventName => {
    const { owner, guest, external } = fixture()
    const event = { preventDefault: vi.fn() }
    guest.emit(eventName, event, 'https://pan.quark.cn/s/Ab12?pwd=Cd34')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(owner.send).toHaveBeenCalledWith(RESOURCE_SHARE_OPEN_CHANNEL, { guestId: 42, url: 'https://pan.quark.cn/s/Ab12?pwd=Cd34', password: 'Cd34' })
    expect(external).not.toHaveBeenCalled()
    event.preventDefault.mockClear()
    guest.emit(eventName, event, 'https://source.example.test/results')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
  it('retains ordinary external-link policy and denies privileged protocols', () => {
    const { owner, guest, open, external } = fixture()
    open({ url: 'https://news.example.test/' }); expect(external).toHaveBeenCalledWith('https://news.example.test/')
    guest.emit('will-navigate', { preventDefault: vi.fn() }, 'https://docs.example.test/')
    expect(external).toHaveBeenCalledWith('https://docs.example.test/')
    open({ url: 'file:///C:/private' }); open({ url: 'javascript:alert(1)' })
    expect(external).toHaveBeenCalledTimes(2); expect(owner.send).not.toHaveBeenCalled()
  })
  it('refuses a guest from another owner and a renderer that lost its trusted origin', () => {
    const { owner, guest, open, trusted, external } = fixture()
    guest.hostWebContents = {} as typeof owner
    open({ url: 'https://pan.quark.cn/s/Ab12' })
    expect(owner.send).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled()
    guest.hostWebContents = owner; trusted.mockReturnValue(false)
    open({ url: 'https://pan.quark.cn/s/Ab12' })
    expect(owner.send).not.toHaveBeenCalled()
  })
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('cleans owner listeners and refuses late callbacks after %s', eventName => {
    const { owner, guest, open } = fixture()
    owner.emit(eventName, {}, 'https://other.example.test/', false, true)
    open({ url: 'https://pan.quark.cn/s/Ab12' })
    expect(owner.send).not.toHaveBeenCalled()
    expect(guest.listenerCount('will-navigate')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })
  it('cleans guest listeners and refuses late popup callbacks after detach', () => {
    const { owner, guest, open } = fixture()
    guest.emit('destroyed'); open({ url: 'https://pan.quark.cn/s/Ab12' })
    expect(owner.send).not.toHaveBeenCalled()
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(guest.listenerCount('will-redirect')).toBe(0)
  })
})
