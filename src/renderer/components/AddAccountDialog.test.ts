// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ addAccount: vi.fn(), pan123FetchToken: vi.fn(), aliyunExchangeCode: vi.fn(),
  openXunleiLogin: vi.fn(), openQuarkLogin: vi.fn(), loginBaiduCookie: vi.fn(), loginUc: vi.fn(),
  loginBaidu: vi.fn(), getInlineLoginStatus: vi.fn(), resetInlineLoginSession: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), push: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: api.push }) }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
import AddAccountDialog from './AddAccountDialog.vue'

let wrapper: VueWrapper
beforeEach(() => {
  vi.clearAllMocks()
  api.addAccount.mockResolvedValue({ success: true })
  api.pan123FetchToken.mockResolvedValue({ success: true, tokens: { accessToken: 'fixture-access', expiresIn: 60 } })
  api.aliyunExchangeCode.mockResolvedValue({ success: true, tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })
  wrapper = mount(AddAccountDialog, { props: { modelValue: true }, global: { stubs: {
    ElDialog: { template: '<div><slot /><slot name="footer" /></div>' },
  } } })
})
afterEach(() => wrapper.unmount())

async function platform(value: string) {
  const select = wrapper.getComponent({ name: 'ElSelect' })
  select.vm.$emit('update:modelValue', value)
  select.vm.$emit('change', value)
  await flushPromises()
}
async function click(text: string) {
  await wrapper.findAll('button').find(button => button.text() === text)!.trigger('click')
  await flushPromises()
}
async function input(placeholder: string, value: string) {
  await wrapper.get(`[placeholder="${placeholder}"]`).setValue(value)
}

describe('account creation through visible controls', () => {
  it.each([
    ['quark', '粘贴完整的 Cookie 字符串'],
    ['baidu', '粘贴百度网盘 Cookie（至少包含 BDUSS）'],
    ['uc', '粘贴 UC 网盘 Cookie'],
  ])('submits the %s cookie account', async (name, placeholder) => {
    await platform(name)
    await click('手动粘贴 Cookie')
    // Cookie controls differ in their help text, but each method has one textarea.
    const control = wrapper.find(`[placeholder="${placeholder}"]`)
    await (control.exists() ? control : wrapper.get('textarea')).setValue(' fixture-cookie ')
    await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: name, loginType: 'cookie', credential: { cookies: 'fixture-cookie' } }))
    expect(wrapper.emitted('success')).toHaveLength(1)
  })

  it('submits WebDAV without entering the Xunlei branch', async () => {
    await platform('webdav')
    await input('https://dav.example.com/dav', 'https://dav.example.test/dav')
    await input('WebDAV 用户名', 'fixture-user')
    await input('WebDAV 密码或应用密码', 'fixture-password')
    await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'webdav', loginType: 'password',
      credential: { serverUrl: 'https://dav.example.test/dav', username: 'fixture-user', password: 'fixture-password' } }))
  })

  it('submits Xunlei manual refresh tokens', async () => {
    await platform('xunlei')
    await click('粘贴 Refresh Token')
    await input('粘贴 refresh_token', 'fixture-refresh')
    await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'xunlei', loginType: 'token', credential: { refreshToken: 'fixture-refresh' } }))
  })

  it.each(['quark', 'baidu', 'uc'] as const)('submits the %s inline login result', async (name) => {
    await platform(name)
    wrapper.getComponent({ name: 'InlineDriveLogin' }).vm.$emit('success', {
      success: true, cookies: 'fixture-cookie', userAgent: 'fixture-agent', nickname: 'fixture-user',
    })
    await flushPromises()
    await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: name, loginType: 'cookie' }))
  })

  it('submits the Xunlei automatic login result', async () => {
    api.openXunleiLogin.mockResolvedValue({ success: true, refreshToken: 'fixture-refresh', accessToken: 'fixture-access', userId: 'fixture-user' })
    await platform('xunlei')
    await click('开始登录')
    await click('添加账号')
    expect(api.openXunleiLogin).toHaveBeenCalledOnce()
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'xunlei', loginType: 'oauth' }))
  })

  it('offers 123 credentials and exchanges them before creating the account', async () => {
    await platform('pan123')
    await input('123开放平台 Client ID', ' fixture-client ')
    await input('123开放平台 Client Secret', 'fixture-secret')
    await click('添加账号')
    expect(api.pan123FetchToken).toHaveBeenCalledWith({ clientId: 'fixture-client', clientSecret: 'fixture-secret' })
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'pan123', loginType: 'api_key', credential: expect.objectContaining({ accessToken: 'fixture-access', clientId: 'fixture-client', clientSecret: 'fixture-secret' }) }))
  })

  it('keeps Ali open and web credentials on their selected platform', async () => {
    await platform('aliyun')
    await input('必须由设置中配置的同一应用签发', 'fixture-open-refresh')
    await click('添加账号')
    expect(api.addAccount).toHaveBeenLastCalledWith(expect.objectContaining({ platform: 'aliyun', credential: { refreshToken: 'fixture-open-refresh' } }))
    await platform('aliyun_web')
    await input('粘贴网页版 refreshToken（较长的一段字符）', 'fixture-web-refresh')
    await click('添加账号')
    expect(api.addAccount).toHaveBeenLastCalledWith(expect.objectContaining({ platform: 'aliyun_web', credential: { refreshToken: 'fixture-web-refresh' } }))
  })

  it('exchanges Ali authorization codes and prevents mixed credential inputs', async () => {
    await platform('aliyun')
    await input('粘贴自有应用的授权码', 'fixture-code')
    await input('必须由设置中配置的同一应用签发', 'fixture-refresh')
    await click('添加账号')
    expect(api.addAccount).not.toHaveBeenCalled()
    await input('必须由设置中配置的同一应用签发', '')
    await click('添加账号')
    expect(api.aliyunExchangeCode).toHaveBeenCalledWith('fixture-code')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'aliyun', credential: expect.objectContaining({ accessToken: 'fixture-access' }) }))
  })

  it('exchanges Baidu OAuth codes into the OAuth account contract', async () => {
    api.loginBaidu.mockResolvedValueOnce({ success: true, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresIn: 60 })
    await platform('baidu')
    await click('OAuth 授权')
    await input('粘贴百度授权后的授权码', 'fixture-code')
    await click('添加账号')
    expect(api.loginBaidu).toHaveBeenCalledWith('fixture-code')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'baidu', loginType: 'oauth', credential: expect.objectContaining({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh' }) }))
  })

  it('shows IPC rejection and clears credentials on close/reopen', async () => {
    api.addAccount.mockRejectedValueOnce(new Error('fixture rejected'))
    await platform('webdav')
    await input('https://dav.example.com/dav', 'https://dav.example.test/dav')
    await input('WebDAV 用户名', 'fixture-user')
    await input('WebDAV 密码或应用密码', 'fixture-password')
    await click('添加账号')
    expect(api.error).toHaveBeenCalledWith('fixture rejected')
    expect(wrapper.emitted('success')).toBeUndefined()
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await platform('webdav')
    expect((wrapper.get('[placeholder="WebDAV 密码或应用密码"]').element as HTMLInputElement).value).toBe('')
  })
})
