// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ previewConfigBackup: vi.fn(), importConfigBackup: vi.fn(), confirm: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, error: api.error } }))
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({ ElMessageBox: { confirm: api.confirm } }))
import BackupRestore from './BackupRestore.vue'

const preview = { createdAt: '2026-09-07T00:00:00Z', tables: [], warnings: [], totals: { incoming: 2, inserts: 2, updates: 0, deletes: 0 } }
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  api.previewConfigBackup.mockResolvedValue({ success: true, preview })
  api.importConfigBackup.mockResolvedValue({ success: true })
  api.confirm.mockResolvedValue('confirm')
})
afterEach(() => { wrapper?.unmount() })

async function render() {
  wrapper = mount(BackupRestore, { global: { stubs: { ElTable: true, ElTableColumn: true, AppSnapshotsPanel: true } } })
  await wrapper.getComponent({ name: 'ElUpload' }).props('onChange')({ name: 'backup.json', raw: { size: 20, text: async () => '{"backup":true}' } })
  await flushPromises()
  return wrapper
}

it('requires preview and explicit confirmation before restoring the selected backup', async () => {
  const view = await render()
  expect(view.find('.preview-card').exists()).toBe(false)
  await view.findAll('button').find(button => button.text() === '校验并预览')!.trigger('click')
  await flushPromises()
  const restore = view.findAll('button').find(button => button.text() === '确认恢复')!
  expect(restore.attributes('disabled')).toBeDefined()
  await view.get('input[type="checkbox"]').setValue(true)
  await restore.trigger('click')
  await flushPromises()
  expect(api.importConfigBackup).toHaveBeenCalledWith('{"backup":true}', { mode: 'merge' })
  expect(view.find('.preview-card').exists()).toBe(false)
})

it('invalidates a confirmed preview when the restore mode changes', async () => {
  const view = await render()
  await view.findAll('button').find(button => button.text() === '校验并预览')!.trigger('click')
  await flushPromises()
  await view.get('input[type="checkbox"]').setValue(true)
  await view.get('input[type="radio"][value="replace"]').setValue(true)
  await flushPromises()
  expect(view.find('.preview-card').exists()).toBe(false)
  expect(api.importConfigBackup).not.toHaveBeenCalled()
})

it('discards an old preview response after switching restore mode', async () => {
  let resolvePreview!: (value: unknown) => void
  api.previewConfigBackup.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve }))
  const view = await render()
  await view.findAll('button').find(button => button.text() === '校验并预览')!.trigger('click')
  await view.get('input[type="radio"][value="replace"]').setValue(true)
  resolvePreview({ success: true, preview })
  await flushPromises()
  expect(view.find('.preview-card').exists()).toBe(false)
  expect(api.importConfigBackup).not.toHaveBeenCalled()
})

it('invalidates the old preview when a replacement backup is too large', async () => {
  const view = await render()
  await view.findAll('button').find(button => button.text() === '校验并预览')!.trigger('click'); await flushPromises()
  await view.get('input[type="checkbox"]').setValue(true)
  await view.getComponent({ name: 'ElUpload' }).props('onChange')({ name: 'large.json', raw: { size: 21 * 1024 * 1024 } })
  await flushPromises()
  expect(view.find('.preview-card').exists()).toBe(false)
  expect(api.importConfigBackup).not.toHaveBeenCalled()
})

it('does not replace the latest selected file with an older delayed read', async () => {
  const view = await render()
  let resolveOld!: (text: string) => void
  const old = view.getComponent({ name: 'ElUpload' }).props('onChange')({ name: 'old.json', raw: { size: 5, text: () => new Promise<string>(resolve => { resolveOld = resolve }) } })
  await view.getComponent({ name: 'ElUpload' }).props('onChange')({ name: 'new.json', raw: { size: 5, text: async () => '{"new":true}' } })
  resolveOld('{"old":true}'); await old; await flushPromises()
  await view.findAll('button').find(button => button.text() === '校验并预览')!.trigger('click'); await flushPromises()
  expect(api.previewConfigBackup).toHaveBeenLastCalledWith('{"new":true}', { mode: 'merge' })
})
