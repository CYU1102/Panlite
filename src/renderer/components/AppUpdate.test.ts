// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../shared/app-update'
const api = vi.hoisted(() => ({ getAppUpdateState: vi.fn(), onAppUpdateChanged: vi.fn(), checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(), installAppUpdate: vi.fn(), error: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: api.error } }))
import AppUpdate from './AppUpdate.vue'
let wrapper: VueWrapper | undefined
let emit: (state: AppUpdateState) => void
beforeEach(() => {
  vi.clearAllMocks()
  api.onAppUpdateChanged.mockImplementation(callback => { emit = callback; return api.unsubscribe })
  api.getAppUpdateState.mockResolvedValue({ phase: 'idle', revision: 0 })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })
it('shows disabled builds without offering downloads or installation', async () => {
  api.getAppUpdateState.mockResolvedValue({ phase: 'disabled', revision: 0 })
  wrapper = mount(AppUpdate); await flushPromises()
  expect(wrapper.text()).toContain('暂不支持')
  expect(wrapper.findAll('button')).toHaveLength(0)
})
it('ignores stale status responses and unregisters the listener on unmount', async () => {
  let resolve!: (state: AppUpdateState) => void
  api.getAppUpdateState.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  wrapper = mount(AppUpdate)
  emit({ phase: 'available', version: '0.3.0', revision: 2 })
  resolve({ phase: 'idle', revision: 0 }); await flushPromises()
  expect(wrapper.text()).toContain('0.3.0')
  wrapper.unmount(); wrapper = undefined
  expect(api.unsubscribe).toHaveBeenCalledOnce()
})
it('offers installation only after download verification and displays task errors', async () => {
  wrapper = mount(AppUpdate); await flushPromises()
  emit({ phase: 'downloading', percent: 50, revision: 1 }); await flushPromises()
  expect(wrapper.text()).not.toContain('安装并重启')
  emit({ phase: 'downloaded', version: '0.3.0', revision: 2 }); await flushPromises()
  api.installAppUpdate.mockResolvedValue({ success: false, error: '任务仍在运行', state: { phase: 'downloaded', revision: 2 } })
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(api.installAppUpdate).toHaveBeenCalledOnce()
  expect(api.error).toHaveBeenCalledWith('任务仍在运行')
})
