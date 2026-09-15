// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ appLockGetState: vi.fn(), appLockConfigure: vi.fn(), appLockChangePassword: vi.fn(),
  appLockDisable: vi.fn(), appLockSetAutoLock: vi.fn(), appLockLock: vi.fn(), getAppLockStatus: vi.fn(),
  unlockApp: vi.fn(), onAppLockChanged: vi.fn(), touchAppLock: vi.fn(), remove: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
import Security from './Security.vue'
import AppLockOverlay from '../components/AppLockOverlay.vue'

let wrapper: VueWrapper | undefined
let listener: (state: unknown) => void
const state = { enabled: true, status: 'unlocked', autoLockMs: 300_000, locked: false }
function model(view: VueWrapper): Record<string, any> { return view.vm as unknown as Record<string, any> }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('electronAPI', api)
  api.appLockGetState.mockResolvedValue({ success: true, ...state })
  api.getAppLockStatus.mockResolvedValue({ success: true, ...state, locked: true, status: 'locked' })
  api.onAppLockChanged.mockImplementation(callback => { listener = callback; return api.remove })
  for (const method of ['appLockConfigure', 'appLockChangePassword', 'appLockDisable', 'appLockSetAutoLock', 'appLockLock', 'touchAppLock'] as const) api[method].mockResolvedValue({ success: true })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('reads the actual flat security IPC state and validates the password before enabling', async () => {
  wrapper = shallowMount(Security); await flushPromises(); const vm = model(wrapper)
  expect(vm.bridgeAvailable).toBe(true); expect(vm.lockState.autoLockMs).toBe(300_000)
  vm.enableForm.password = 'short'; vm.enableForm.confirmPassword = 'short'; await vm.enableLock()
  expect(api.appLockConfigure).not.toHaveBeenCalled()
  vm.enableForm.password = 'fixture-password'; vm.enableForm.confirmPassword = 'fixture-password'; await vm.enableLock()
  expect(api.appLockConfigure).toHaveBeenCalledWith('fixture-password', 300_000)
  expect(vm.enableForm.password).toBe('')
})

it('keeps password-change errors visible and restores the previous auto-lock duration on failure', async () => {
  wrapper = shallowMount(Security); await flushPromises(); const vm = model(wrapper)
  api.appLockChangePassword.mockResolvedValueOnce({ success: false, error: 'fixture incorrect password' })
  vm.changeForm.currentPassword = 'fixture-current'; vm.changeForm.newPassword = 'fixture-new'; vm.changeForm.confirmPassword = 'fixture-new'
  await vm.changePassword(); expect(api.error).toHaveBeenCalledWith('fixture incorrect password')
  api.appLockSetAutoLock.mockResolvedValueOnce({ success: false, error: 'fixture denied' })
  vm.selectedAutoLockMs = 60_000; await vm.saveAutoLock(60_000)
  expect(vm.selectedAutoLockMs).toBe(300_000); expect(vm.savingAutoLock).toBe(false)
})

it('sends disable and immediate-lock requests through the actual preload aliases', async () => {
  wrapper = shallowMount(Security); await flushPromises(); const vm = model(wrapper)
  vm.disablePassword = 'fixture-password'; await vm.disableLock()
  expect(api.appLockDisable).toHaveBeenCalledWith('fixture-password'); expect(vm.disablePassword).toBe('')
  await vm.lockNow(); expect(api.appLockLock).toHaveBeenCalledOnce()
})

it('keeps a failed unlock locked, accepts updated state, and removes the event listener', async () => {
  wrapper = shallowMount(AppLockOverlay, { global: { stubs: { ElInput: { template: '<input />', methods: { focus() {} } } } } }); await flushPromises(); const vm = model(wrapper)
  expect(vm.locked).toBe(true)
  api.unlockApp.mockResolvedValueOnce({ success: false, error: 'fixture wrong password' })
  vm.password = 'fixture-password'; await vm.unlock()
  expect(vm.locked).toBe(true); expect(vm.error).toBe('fixture wrong password'); expect(vm.password).toBe('')
  api.unlockApp.mockResolvedValueOnce({ success: true, enabled: true, locked: false })
  vm.password = 'fixture-correct'; await vm.unlock(); expect(vm.locked).toBe(false)
  listener({ enabled: true, locked: true }); expect(vm.locked).toBe(true)
  wrapper.unmount(); wrapper = undefined; expect(api.remove).toHaveBeenCalledOnce()
})
