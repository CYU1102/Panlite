// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getInlineLoginStatus: vi.fn(), resetInlineLoginSession: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import InlineDriveLogin from './InlineDriveLogin.vue'

describe('inline drive login', () => {
  it('loads the provider in its isolated partition and emits verified credentials', async () => {
    api.getInlineLoginStatus.mockResolvedValue({
      state: 'success',
      result: { success: true, cookies: 'BDUSS=fixture', nickname: '扫码用户' },
    })
    const wrapper = mount(InlineDriveLogin, { props: { platform: 'baidu' } })
    const webview = wrapper.get('webview')
    Object.defineProperty(webview.element, 'getWebContentsId', { value: () => 42 })
    webview.element.dispatchEvent(new Event('dom-ready'))
    await flushPromises()

    expect(webview.attributes('src')).toBe('https://pan.baidu.com/')
    expect(webview.attributes('partition')).toBe('persist:baidu-login')
    expect(api.getInlineLoginStatus).toHaveBeenCalledWith({ platform: 'baidu', webContentsId: 42 })
    expect(wrapper.emitted('success')?.[0]?.[0]).toMatchObject({ success: true, nickname: '扫码用户' })
    expect(wrapper.text()).toContain('登录成功')

    api.resetInlineLoginSession.mockResolvedValue({ success: true })
    const reload = vi.fn()
    Object.defineProperty(webview.element, 'reloadIgnoringCache', { value: reload })
    await wrapper.findAll('button').find((item) => item.text() === '切换账号')!.trigger('click')
    await flushPromises()
    expect(api.resetInlineLoginSession).toHaveBeenCalledWith({ platform: 'baidu', webContentsId: 42 })
    expect(reload).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('keeps the independent-window fallback visible', async () => {
    const wrapper = mount(InlineDriveLogin, { props: { platform: 'quark' } })
    const button = wrapper.findAll('button').find((item) => item.text() === '独立窗口登录')
    await button!.trigger('click')
    expect(wrapper.emitted('fallback')).toHaveLength(1)
    wrapper.unmount()
  })
})
