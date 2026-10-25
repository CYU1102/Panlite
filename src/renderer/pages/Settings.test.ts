// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Settings from './Settings.vue'

const api = vi.hoisted(() => ({
  getAllSettings: vi.fn(), setSetting: vi.fn(), getClipboardMonitor: vi.fn(), getGlobalShortcuts: vi.fn(),
  searchSourcesList: vi.fn(), tgChannelsList: vi.fn(), crawlerSourcesList: vi.fn(), kkSourcesList: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, error: api.error } }))
interface SettingsModel {
  form: { baiduClientId: string; requestDelayMs: number; transferParallelChunks: number; transferTempDir: string }
  hasChanges: boolean
  settingsLoaded: boolean
  settingsLoadError: string
  loadSettings(): Promise<void>
  onSave(): Promise<void>
}
const views: ReturnType<typeof shallowMount>[] = []
function render() {
  const view = shallowMount(Settings, { global: { plugins: [createPinia()] } })
  views.push(view)
  return { view, vm: view.vm as unknown as SettingsModel }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('__APP_VERSION__', 'fixture')
  api.getAllSettings.mockResolvedValue({ success: true, settings: {} })
  api.setSetting.mockResolvedValue({ success: true })
  api.getClipboardMonitor.mockResolvedValue({ success: true, enabled: false })
  api.getGlobalShortcuts.mockResolvedValue({ success: true, enabled: false })
  api.searchSourcesList.mockResolvedValue({ success: true, sources: [] })
  api.tgChannelsList.mockResolvedValue({ success: true, channels: [] })
  api.crawlerSourcesList.mockResolvedValue({ success: true, sources: [] })
  api.kkSourcesList.mockResolvedValue({ success: true, sources: [] })
})
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.unstubAllGlobals() })

it('preserves edits made during the first read and saves them against the persisted baseline', async () => {
  const pending = deferred<unknown>(); api.getAllSettings.mockReturnValueOnce(pending.promise)
  const { vm } = render()
  vm.form.baiduClientId = 'draft-client'
  vm.form.requestDelayMs = 500
  await vm.onSave(); expect(api.setSetting).not.toHaveBeenCalled()
  pending.resolve({ success: true, settings: { baiduClientId: 'saved-client', requestDelayMs: '400', transferParallelChunks: '6' } })
  await flushPromises()
  expect(vm.form.baiduClientId).toBe('draft-client')
  expect(vm.form.requestDelayMs).toBe(500)
  expect(vm.form.transferParallelChunks).toBe(6)
  expect(vm.settingsLoaded).toBe(true); expect(vm.hasChanges).toBe(true)
  await vm.onSave()
  expect(api.setSetting).toHaveBeenCalledWith('baiduClientId', 'draft-client')
  expect(api.setSetting).toHaveBeenCalledWith('requestDelayMs', '500')
  expect(vm.hasChanges).toBe(false)
})

it('keeps a draft entered after a read failure when retrying the read', async () => {
  api.getAllSettings.mockResolvedValueOnce({ success: false, error: 'read unavailable' })
  const { vm } = render(); await flushPromises()
  vm.form.baiduClientId = 'draft-after-failure'
  api.getAllSettings.mockResolvedValueOnce({ success: true, settings: { baiduClientId: 'stored-client', transferTempDir: 'D:/stored-temp' } })
  await vm.loadSettings()
  expect(vm.form.baiduClientId).toBe('draft-after-failure')
  expect(vm.form.transferTempDir).toBe('D:/stored-temp')
  expect(vm.settingsLoadError).toBe('')
  expect(vm.hasChanges).toBe(true)
})

it('retains an explicitly edited field even when it returns to its initial default during the read', async () => {
  const pending = deferred<unknown>(); api.getAllSettings.mockReturnValueOnce(pending.promise)
  const { vm } = render()
  vm.form.requestDelayMs = 500
  vm.form.requestDelayMs = 300
  pending.resolve({ success: true, settings: { requestDelayMs: '800' } }); await flushPromises()
  expect(vm.form.requestDelayMs).toBe(300)
  expect(vm.hasChanges).toBe(true)
})

it('retains existing unsaved changes when another read supplies a newer baseline', async () => {
  api.getAllSettings.mockResolvedValueOnce({ success: true, settings: { baiduClientId: 'stored-client', transferParallelChunks: '2' } })
  const { vm } = render(); await flushPromises()
  vm.form.baiduClientId = 'unsaved-client'
  api.getAllSettings.mockResolvedValueOnce({ success: true, settings: { baiduClientId: 'new-stored-client', transferParallelChunks: '7' } })
  await vm.loadSettings()
  expect(vm.form.baiduClientId).toBe('unsaved-client')
  expect(vm.form.transferParallelChunks).toBe(7)
  expect(vm.hasChanges).toBe(true)
})

it('ignores an earlier read response after the latest request has completed', async () => {
  const earlier = deferred<unknown>(); api.getAllSettings.mockReturnValueOnce(earlier.promise)
  const { vm } = render()
  api.getAllSettings.mockResolvedValueOnce({ success: true, settings: { requestDelayMs: '600' } })
  await vm.loadSettings()
  earlier.resolve({ success: true, settings: { requestDelayMs: '900' } }); await flushPromises()
  expect(vm.form.requestDelayMs).toBe(600)
  expect(vm.hasChanges).toBe(false)
})

it('does not apply a completed read after the settings page unmounts', async () => {
  const pending = deferred<unknown>(); api.getAllSettings.mockReturnValueOnce(pending.promise)
  const { view, vm } = render()
  view.unmount(); views.splice(views.indexOf(view), 1)
  pending.resolve({ success: true, settings: { baiduClientId: 'late-client' } }); await flushPromises()
  expect(vm.settingsLoaded).toBe(false)
  expect(vm.form.baiduClientId).toBe('')
})
