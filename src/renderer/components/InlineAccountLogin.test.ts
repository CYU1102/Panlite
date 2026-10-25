// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InlineLoginResult } from '@shared/inline-login'
const api = vi.hoisted(() => ({ startInlineLogin: vi.fn(), getInlineLoginStatus: vi.fn(), cancelInlineLogin: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import InlineAccountLogin from './InlineAccountLogin.vue'
const descriptor = (id = 'fixture') => ({ id, platform: 'quark' as const, partition: `panlite-inline-login-${id}`, url: 'https://pan.quark.cn/' })
let wrapper: VueWrapper
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  api.startInlineLogin.mockResolvedValue({ success: true, state: 'waiting', session: descriptor() })
  api.getInlineLoginStatus.mockResolvedValue({ success: true, state: 'waiting' })
  api.cancelInlineLogin.mockResolvedValue({ success: true })
  wrapper = mount(InlineAccountLogin, { props: { platform: 'quark' } })
})
afterEach(() => { wrapper.unmount(); vi.useRealTimers() })
async function click(text: string) { await wrapper.findAll('button').find(button => button.text() === text)!.trigger('click'); await flushPromises() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }

describe('inline login lifecycle', () => {
  it('embeds the returned official session and verifies on DOM readiness', async () => {
    await click('开始登录')
    expect(api.startInlineLogin).toHaveBeenCalledWith('quark')
    expect(wrapper.get('webview').attributes()).toMatchObject({ src: descriptor().url, partition: descriptor().partition })
    expect(wrapper.get('webview').attributes('preload')).toBeUndefined()
    expect(wrapper.get('webview').attributes('nodeintegration')).toBeUndefined()
    await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    expect(api.getInlineLoginStatus).toHaveBeenCalledWith('fixture')
    expect(wrapper.text()).toContain('等待扫码登录')
  })
  it('emits verified credentials once and clears the browser session', async () => {
    api.getInlineLoginStatus.mockResolvedValueOnce({ success: true, state: 'success', cookies: 'auth=fixture', nickname: 'Fixture user' })
    await click('开始登录'); await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    const results = wrapper.emitted('result')!
    expect(results[results.length - 1]).toEqual([expect.objectContaining({ cookies: 'auth=fixture' })])
    expect(wrapper.text()).toContain('Fixture user')
    expect(wrapper.find('webview').exists()).toBe(false)
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('fixture')
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.getInlineLoginStatus).toHaveBeenCalledOnce()
  })
  it('refreshes into a new session and never accepts a previous in-flight verification', async () => {
    const old = deferred<InlineLoginResult>(); api.getInlineLoginStatus.mockReturnValueOnce(old.promise)
    await click('开始登录'); await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    api.startInlineLogin.mockResolvedValueOnce({ success: true, session: descriptor('new') })
    await click('刷新二维码')
    old.resolve({ success: true, state: 'success', cookies: 'stale-cookie' }); await flushPromises()
    expect(wrapper.emitted('result')?.some(args => (args[0] as InlineLoginResult).cookies)).toBe(false)
    expect(wrapper.get('webview').attributes('partition')).toBe(descriptor('new').partition)
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('fixture')
  })
  it('releases a delayed start response after the dialog is unmounted', async () => {
    const pending = deferred<InlineLoginResult>(); api.startInlineLogin.mockReturnValueOnce(pending.promise)
    await click('开始登录'); wrapper.unmount()
    pending.resolve({ success: true, session: descriptor('late') }); await flushPromises()
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('late')
    expect(api.getInlineLoginStatus).not.toHaveBeenCalled()
  })
  it('cancels immediately and suppresses late verified credentials', async () => {
    const pending = deferred<InlineLoginResult>(); api.getInlineLoginStatus.mockReturnValueOnce(pending.promise)
    await click('开始登录'); await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    await click('取消登录')
    pending.resolve({ success: true, state: 'success', cookies: 'cancelled-cookie' }); await flushPromises()
    expect(wrapper.find('webview').exists()).toBe(false)
    expect(wrapper.emitted('result')?.some(args => (args[0] as InlineLoginResult).cookies)).toBe(false)
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('fixture')
  })
  it('exposes expiry and offers fresh login without automatically opening windows', async () => {
    api.getInlineLoginStatus.mockResolvedValueOnce({ success: false, state: 'expired', error: '登录会话已过期，请刷新二维码' })
    await click('开始登录'); await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('已过期')
    expect(wrapper.emitted('fallback')).toBeUndefined()
    await click('使用官方登录窗口')
    expect(wrapper.emitted('fallback')).toHaveLength(1)
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('fixture')
  })
  it('ignores subframe load errors but reports main-frame failures and stops verification', async () => {
    await click('开始登录')
    await wrapper.get('webview').trigger('did-fail-load', { errorCode: -105, isMainFrame: false })
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await wrapper.get('webview').trigger('did-fail-load', { errorCode: -105, isMainFrame: true, errorDescription: 'Name not resolved' }); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Name not resolved')
    expect(api.cancelInlineLogin).toHaveBeenCalledWith('fixture')
    await vi.advanceTimersByTimeAsync(5000); expect(api.getInlineLoginStatus).not.toHaveBeenCalled()
  })
  it('coalesces repeated ready events and recovers after transient verification errors', async () => {
    const pending = deferred<InlineLoginResult>(); api.getInlineLoginStatus.mockReturnValueOnce(pending.promise)
    await click('开始登录'); await wrapper.get('webview').trigger('dom-ready'); await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    expect(api.getInlineLoginStatus).toHaveBeenCalledOnce()
    pending.resolve({ success: true, state: 'waiting', error: '暂时无法验证登录，请重试' }); await flushPromises()
    expect(wrapper.text()).toContain('暂时无法验证登录')
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.getInlineLoginStatus).toHaveBeenCalledTimes(2)
  })
  it('reports preparation errors and retries on the same page', async () => {
    api.startInlineLogin.mockRejectedValueOnce(new Error('Session unavailable'))
    await click('开始登录')
    expect(wrapper.get('[role="alert"]').text()).toContain('Session unavailable')
    await click('重新加载')
    expect(wrapper.find('webview').exists()).toBe(true)
    expect(wrapper.emitted('fallback')).toBeUndefined()
  })
  it.each([['quark', 417, 0], ['quark', 300, 100], ['uc', 417, 193], ['uc', 300, 310]] as const)('positions the full-size %s login area at frame height %s and allows manual repositioning', async (platform, height, expectedTop) => {
    await wrapper.setProps({ platform }); await click('开始登录')
    const frame = wrapper.get('.inline-frame').element as HTMLDivElement
    Object.defineProperties(frame, { scrollWidth: { value: 1280 }, clientWidth: { value: 600 }, clientHeight: { value: height } })
    await wrapper.get('webview').trigger('dom-ready'); await flushPromises()
    expect(frame.scrollLeft).toBe(680)
    expect(frame.scrollTop).toBe(expectedTop)
    expect(wrapper.get('.inline-frame').attributes('tabindex')).toBe('0')
    frame.scrollLeft = 0; frame.scrollTop = 0
    await click('定位登录区')
    expect(frame.scrollLeft).toBe(680)
    expect(frame.scrollTop).toBe(expectedTop)
  })
})
