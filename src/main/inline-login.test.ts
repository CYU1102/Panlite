import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))
import { InlineLoginManager } from './inline-login'
import { isInlineLoginUrl } from '../shared/inline-login'

function owner() {
  const target = new EventEmitter()
  return Object.assign(target, { isDestroyed: vi.fn(() => false) }) as unknown as WebContents
}
function sessionFixture() {
  return Object.assign(new EventEmitter(), {
    setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    cookies: { get: vi.fn().mockResolvedValue([{ domain: '.quark.cn', name: 'auth', value: 'fixture' }]) },
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, code: 0, data: { nickname: 'Fixture account' } }) }),
    clearStorageData: vi.fn().mockResolvedValue(undefined), clearCache: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
  })
}
const managers: InlineLoginManager[] = []
function fixture() {
  let now = 1000
  const sessions: ReturnType<typeof sessionFixture>[] = []
  const manager = new InlineLoginManager(() => { const ses = sessionFixture(); sessions.push(ses); return ses as unknown as Session }, () => now)
  managers.push(manager)
  const host = owner()
  const attach = (ses = sessions[sessions.length - 1]) => {
    const guest = Object.assign(new EventEmitter(), { session: ses, isDestroyed: vi.fn(() => false), stop: vi.fn(), close: vi.fn(), setWindowOpenHandler: vi.fn(), loadURL: vi.fn().mockResolvedValue(undefined) })
    guest.close.mockImplementation(() => { guest.isDestroyed.mockReturnValue(true); guest.emit('destroyed') })
    expect(manager.attach(host, guest as unknown as WebContents)).toBe(true)
    return guest
  }
  return { manager, host, sessions, attach, advance: (ms: number) => { now += ms } }
}
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.dispose())) })

describe('isolated inline official login', () => {
  it('permits only official HTTPS hosts and rejects deceptive hostnames or credentials', () => {
    expect(isInlineLoginUrl('quark', 'https://pan.quark.cn/')).toBe(true)
    expect(isInlineLoginUrl('uc', 'https://passport.uc.cn/login')).toBe(true)
    for (const url of ['http://pan.quark.cn/', 'https://pan.quark.cn.evil.test/', 'https://evilquark.cn/', 'https://user:secret@quark.cn/', 'file:///C:/x', 'https://quark.cn:8080/']) expect(isInlineLoginUrl('quark', url)).toBe(false)
  })
  it('uses a fresh nonpersistent session and accepts attachment only from its owner', async () => {
    const { manager, host } = fixture()
    const result = await manager.start(host, 'quark'), descriptor = result.session!
    expect(descriptor.partition).toMatch(/^panlite-inline-login-/)
    expect(descriptor.partition).not.toContain('persist:')
    expect(manager.allowsAttachment(host, descriptor.partition, descriptor.url)).toBe(true)
    expect(manager.allowsAttachment(owner(), descriptor.partition, descriptor.url)).toBe(false)
    expect(manager.allowsAttachment(host, descriptor.partition, 'https://passport.quark.cn/')).toBe(false)
    expect(await manager.start(host, 'baidu')).toMatchObject({ success: false })
  })
  it('never exposes another owner’s credentials or lets them cancel its session', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    expect(await manager.status(owner(), descriptor.id)).toMatchObject({ success: false })
    await manager.cancel(owner(), descriptor.id)
    expect(sessions[0].fetch).not.toHaveBeenCalled()
    expect(await manager.status(host, descriptor.id)).toMatchObject({ success: true, state: 'success', cookies: 'auth=fixture' })
  })
  it('waits until a real guest attaches and until the service validates a nickname', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!
    expect(await manager.status(host, descriptor.id)).toEqual({ success: true, state: 'waiting' })
    attach()
    sessions[0].fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: false, code: 401, data: { nickname: 'Stale name' } }) })
    expect(await manager.status(host, descriptor.id)).toEqual({ success: true, state: 'waiting' })
    expect(await manager.status(host, descriptor.id)).toMatchObject({ state: 'success', nickname: 'Fixture account' })
  })
  it('excludes unrelated cookies and rejects duplicate attachment', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; const guest = attach()
    sessions[0].cookies.get.mockResolvedValue([{ domain: '.quark.cn', name: 'auth', value: 'fixture' }, { domain: 'quark.cn.evil.test', name: 'secret', value: 'other' }])
    expect(await manager.status(host, descriptor.id)).toMatchObject({ cookies: 'auth=fixture' })
    expect(manager.allowsAttachment(host, descriptor.partition, descriptor.url)).toBe(false)
    expect(manager.attach(host, guest as unknown as WebContents)).toBe(false)
  })
  it('checks UC file permissions before accepting account info and captures API-side cookies', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'uc')).session!; attach()
    sessions[0].cookies.get.mockResolvedValue([{ domain: '.uc.cn', name: 'auth', value: 'uc' }])
    sessions[0].fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 401, data: {} }) })
    expect(await manager.status(host, descriptor.id)).toMatchObject({ state: 'waiting' })
    expect(sessions[0].fetch).toHaveBeenCalledTimes(1)
    sessions[0].fetch.mockImplementationOnce(async () => {
      sessions[0].cookies.get.mockResolvedValue([{ domain: '.uc.cn', name: 'auth', value: 'uc' }, { domain: 'pc-api.uc.cn', name: 'tfstk', value: 'security' }])
      return { ok: true, json: async () => ({ code: 0, data: {} }) }
    })
    expect(await manager.status(host, descriptor.id)).toMatchObject({ state: 'success', cookies: 'auth=uc; tfstk=security' })
    expect(sessions[0].fetch.mock.calls[1][0]).toContain('/member?')
  })
  it('coalesces verification and suppresses a late success after cancel', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; const guest = attach()
    let resolve!: (value: unknown) => void
    sessions[0].fetch.mockImplementationOnce(() => new Promise(onResolve => { resolve = onResolve }))
    const first = manager.status(host, descriptor.id), second = manager.status(host, descriptor.id)
    await vi.waitFor(() => expect(sessions[0].fetch).toHaveBeenCalledOnce())
    const cancellation = manager.cancel(host, descriptor.id)
    resolve({ ok: true, json: async () => ({ data: { nickname: 'Late account' } }) })
    await cancellation
    expect(await first).toMatchObject({ success: false }); expect(await second).toMatchObject({ success: false })
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
  it('rejects malformed nicknames instead of treating arbitrary account JSON as a login', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    for (const nickname of [{ label: 'Invalid shape' }, '   ', null]) {
      sessions[0].fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { nickname } }) })
      expect(await manager.status(host, descriptor.id)).toMatchObject({ state: 'waiting' })
    }
  })
  it('rejects verification that finishes after session expiry', async () => {
    const { manager, host, attach, sessions, advance } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    let resolve!: (value: unknown) => void
    sessions[0].fetch.mockImplementationOnce(() => new Promise(onResolve => { resolve = onResolve }))
    const pending = manager.status(host, descriptor.id)
    await vi.waitFor(() => expect(sessions[0].fetch).toHaveBeenCalledOnce())
    advance(10 * 60_000)
    resolve({ ok: true, json: async () => ({ data: { nickname: 'Expired result' } }) })
    expect(await pending).toMatchObject({ success: false, state: 'expired' })
    expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
  it('clears the session even when its guest disappears during close', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; const guest = attach()
    guest.close.mockImplementationOnce(() => { throw new Error('Object has been destroyed') })
    await manager.cancel(host, descriptor.id)
    expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
    expect(await manager.status(host, descriptor.id)).toMatchObject({ success: false })
  })
  it('makes concurrent owner cancellation wait for the same storage cleanup', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    let clear!: () => void
    sessions[0].clearStorageData.mockImplementationOnce(() => new Promise<void>(resolve => { clear = resolve }))
    const first = manager.cancel(host, descriptor.id)
    await vi.waitFor(() => expect(sessions[0].clearStorageData).toHaveBeenCalledOnce())
    let secondFinished = false
    const second = manager.cancel(host, descriptor.id).then(() => { secondFinished = true })
    await Promise.resolve(); expect(secondFinished).toBe(false)
    clear(); await Promise.all([first, second])
    expect(secondFinished).toBe(true)
    expect(sessions[0].closeAllConnections).toHaveBeenCalledOnce()
    expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
  it('still clears storage when connection shutdown fails and allows cancellation cleanup to be retried', async () => {
    const { manager, host, attach, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    sessions[0].closeAllConnections.mockRejectedValueOnce(new Error('Connection shutdown failed'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await manager.cancel(host, descriptor.id)).toMatchObject({ success: false, error: '登录会话清理失败，请重试取消或关闭应用' })
      expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
      expect(await manager.status(host, descriptor.id)).toMatchObject({ success: false })
      expect(await manager.cancel(host, descriptor.id)).toEqual({ success: true })
      expect(sessions[0].clearStorageData).toHaveBeenCalledTimes(2)
    } finally { warning.mockRestore() }
  })
  it('reports a failed storage clear instead of returning successful cancellation', async () => {
    const { manager, host, sessions } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!
    sessions[0].clearStorageData.mockRejectedValueOnce(new Error('Storage unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await manager.cancel(host, descriptor.id)).toMatchObject({ success: false })
      expect(await manager.cancel(host, descriptor.id)).toEqual({ success: true })
      expect(sessions[0].clearStorageData).toHaveBeenCalledTimes(2)
    } finally { warning.mockRestore() }
  })
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('releases credentials when the owning renderer emits %s', async event => {
    const { manager, host, sessions, attach } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!; attach()
    host.emit(event, {}, 'https://example.test/', false, true)
    await manager.cancel(host, descriptor.id)
    expect(await manager.status(host, descriptor.id)).toMatchObject({ success: false })
    expect(sessions[0].clearStorageData).toHaveBeenCalledOnce()
  })
  it('expires sessions and refreshes with a new partition', async () => {
    const { manager, host, sessions, advance } = fixture()
    const descriptor = (await manager.start(host, 'quark')).session!
    advance(10 * 60_000)
    expect(await manager.status(host, descriptor.id)).toMatchObject({ success: false, state: 'expired' })
    const next = (await manager.start(host, 'quark')).session!
    expect(next.partition).not.toBe(descriptor.partition)
    expect(sessions[0].clearCache).toHaveBeenCalledOnce()
  })
  it('keeps approved popup navigation inside its guest and blocks external navigation', async () => {
    const { manager, host, attach } = fixture()
    await manager.start(host, 'quark'); const guest = attach()
    const open = guest.setWindowOpenHandler.mock.calls[0][0]
    expect(open({ url: 'https://passport.quark.cn/login' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledOnce()
    open({ url: 'https://example.test/' }); expect(guest.loadURL).toHaveBeenCalledOnce()
    const event = { preventDefault: vi.fn() }; guest.emit('will-navigate', event, 'https://evil.test/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
