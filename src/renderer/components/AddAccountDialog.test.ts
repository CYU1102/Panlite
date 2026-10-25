// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ addAccount: vi.fn(), pan123FetchToken: vi.fn(), aliyunExchangeCode: vi.fn(),
  openXunleiLogin: vi.fn(), openQuarkLogin: vi.fn(), loginBaiduCookie: vi.fn(), loginUc: vi.fn(),
  loginBaidu: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), push: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: api.push }) }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
import AddAccountDialog from './AddAccountDialog.vue'
import InlineAccountLogin from './InlineAccountLogin.vue'

let wrapper: VueWrapper
beforeEach(() => {
  vi.resetAllMocks()
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
async function clickLegacyLogin() {
  const buttons = wrapper.findAll('button')
  await (buttons.find(button => button.text() === '使用官方登录窗口') || buttons.find(button => button.text() === '开始登录') )!.trigger('click')
  await flushPromises()
}
async function input(placeholder: string, value: string) {
  await wrapper.get(`[placeholder="${placeholder}"]`).setValue(value)
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

interface DialogModel { onConfirm(): Promise<void>; saving: boolean }
function model() { return wrapper.vm as unknown as DialogModel }

describe('account creation through visible controls', () => {
  it.each(['quark', 'uc'] as const)('saves verified %s inline credentials and ignores an older window login', async name => {
    const pending = deferred<unknown>()
    api[name === 'quark' ? 'openQuarkLogin' : 'loginUc'].mockReturnValueOnce(pending.promise)
    await platform(name); await clickLegacyLogin()
    wrapper.getComponent(InlineAccountLogin).vm.$emit('result', { success: false })
    wrapper.getComponent(InlineAccountLogin).vm.$emit('result', { success: true, state: 'success', cookies: 'inline-cookie', nickname: 'Inline account', userAgent: 'inline-agent' })
    pending.resolve({ success: true, cookies: 'old-window-cookie', nickname: 'Old window' }); await flushPromises()
    await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: name, nickname: 'Inline account', credential: expect.objectContaining({ cookies: 'inline-cookie' }) }))
  })

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

  it.each([
    ['quark', 'openQuarkLogin'], ['baidu', 'loginBaiduCookie'], ['uc', 'loginUc'], ['xunlei', 'openXunleiLogin'],
  ] as const)('submits the %s automatic login result', async (name, method) => {
    api[method].mockResolvedValue({ success: true, cookies: 'fixture-cookie', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', userId: 'fixture-user', userAgent: 'fixture-agent' })
    await platform(name)
    await clickLegacyLogin()
    await click('添加账号')
    expect(api[method]).toHaveBeenCalledOnce()
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: name, loginType: name === 'xunlei' ? 'oauth' : 'cookie' }))
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

  it.each([
    ['quark', 'openQuarkLogin'], ['baidu', 'loginBaiduCookie'], ['uc', 'loginUc'], ['xunlei', 'openXunleiLogin'],
  ] as const)('ignores the old %s login after closing and reopening the dialog', async (name, method) => {
    const pending = deferred<unknown>(); api[method].mockReturnValueOnce(pending.promise)
    await platform(name); await clickLegacyLogin()
    await wrapper.setProps({ modelValue: false }); await wrapper.setProps({ modelValue: true })
    await platform(name)
    pending.resolve({ success: true, cookies: 'old-cookie', accessToken: 'old-access', refreshToken: 'old-refresh' })
    await flushPromises(); await click('添加账号')
    expect(api.addAccount).not.toHaveBeenCalled()
    expect(api.warning).toHaveBeenCalledWith('请先完成登录')
  })

  it('ignores a login invalidated by a method change even after returning to automatic login', async () => {
    const pending = deferred<unknown>(); api.openQuarkLogin.mockReturnValueOnce(pending.promise)
    await clickLegacyLogin(); await click('手动粘贴 Cookie'); await click('网页登录（推荐）')
    pending.resolve({ success: true, cookies: 'old-cookie' }); await flushPromises()
    await click('添加账号')
    expect(api.addAccount).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('开始登录')
  })

  it('does not let an older login failure overwrite a new successful login', async () => {
    const pending = deferred<unknown>(); api.openQuarkLogin.mockReturnValueOnce(pending.promise)
    await clickLegacyLogin()
    await wrapper.setProps({ modelValue: false }); await wrapper.setProps({ modelValue: true })
    api.openQuarkLogin.mockResolvedValueOnce({ success: true, cookies: 'current-cookie' })
    await clickLegacyLogin()
    pending.reject(new Error('old failure')); await flushPromises(); await click('添加账号')
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ credential: expect.objectContaining({ cookies: 'current-cookie' }) }))
    expect(api.error).not.toHaveBeenCalled()
  })

  it('binds 123 tokens to their original credentials and retains the newest save loading state', async () => {
    await platform('pan123')
    await input('123开放平台 Client ID', 'first-client'); await input('123开放平台 Client Secret', 'first-secret')
    const first = deferred<unknown>(), second = deferred<unknown>()
    api.pan123FetchToken.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const earlierSave = model().onConfirm(); await flushPromises()
    await input('123开放平台 Client ID', 'second-client'); await input('123开放平台 Client Secret', 'second-secret')
    const latestSave = model().onConfirm(); await flushPromises()
    first.resolve({ success: true, tokens: { accessToken: 'first-access', expiresIn: 60 } }); await earlierSave
    expect(api.addAccount).not.toHaveBeenCalled(); expect(model().saving).toBe(true)
    second.resolve({ success: true, tokens: { accessToken: 'second-access', expiresIn: 60 } }); await latestSave
    expect(api.addAccount).toHaveBeenCalledTimes(1)
    expect(api.addAccount).toHaveBeenCalledWith(expect.objectContaining({ platform: 'pan123', credential: expect.objectContaining({ accessToken: 'second-access', clientId: 'second-client', clientSecret: 'second-secret' }) }))
  })

  it.each(['aliyun', 'baidu'] as const)('does not save a stale %s authorization exchange after its code changes', async name => {
    await platform(name)
    if (name === 'baidu') await click('OAuth 授权')
    const placeholder = name === 'aliyun' ? '粘贴自有应用的授权码' : '粘贴百度授权后的授权码'
    await input(placeholder, 'first-code')
    const pending = deferred<unknown>()
    api[name === 'aliyun' ? 'aliyunExchangeCode' : 'loginBaidu'].mockReturnValueOnce(pending.promise)
    const save = model().onConfirm(); await flushPromises()
    if (name === 'baidu') { await click('手动粘贴 Cookie'); await click('OAuth 授权') }
    await input(placeholder, 'second-code')
    pending.resolve(name === 'aliyun'
      ? { success: true, tokens: { access_token: 'stale-access' } }
      : { success: true, accessToken: 'stale-access' })
    await save
    expect(api.addAccount).not.toHaveBeenCalled()
    expect(model().saving).toBe(false)
  })

  it('does not create an account when its credential exchange finishes after cancellation', async () => {
    await platform('pan123')
    await input('123开放平台 Client ID', 'fixture-client'); await input('123开放平台 Client Secret', 'fixture-secret')
    const pending = deferred<unknown>(); api.pan123FetchToken.mockReturnValueOnce(pending.promise)
    const save = model().onConfirm(); await flushPromises()
    await click('取消')
    pending.resolve({ success: true, tokens: { accessToken: 'cancelled-access', expiresIn: 60 } }); await save
    expect(api.addAccount).not.toHaveBeenCalled()
    expect(wrapper.emitted('success')).toBeUndefined()
  })

  it('does not clear a reopened form when an earlier account save finishes', async () => {
    await platform('webdav')
    await input('https://dav.example.com/dav', 'https://old.example.test/dav')
    await input('WebDAV 用户名', 'old-user'); await input('WebDAV 密码或应用密码', 'old-password')
    const pending = deferred<unknown>(); api.addAccount.mockReturnValueOnce(pending.promise)
    const save = model().onConfirm(); await flushPromises()
    await wrapper.setProps({ modelValue: false }); await wrapper.setProps({ modelValue: true })
    await platform('webdav'); await input('WebDAV 用户名', 'new-user')
    pending.resolve({ success: true }); await save
    expect((wrapper.get('[placeholder="WebDAV 用户名"]').element as HTMLInputElement).value).toBe('new-user')
    expect(wrapper.emitted('success')).toBeUndefined()
    expect(api.success).not.toHaveBeenCalled()
  })
})
