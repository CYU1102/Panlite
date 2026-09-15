// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/types'
import { useAppStore } from '../stores/app'

const api = vi.hoisted(() => ({ listFiles: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { warning: api.warning, error: api.error } }))
import FileManager from './FileManager.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })
const file: FileItem = { id: 'archive', name: 'archive.zip', accountId: 'account', platform: 'quark', parentId: '0', isDir: false, size: 42, createdAt: 0, updatedAt: 0 }

async function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useAppStore()
  store.currentAccount = { id: 'account', platform: 'quark', nickname: 'Account' } as NonNullable<typeof store.currentAccount>
  api.listFiles.mockResolvedValue({ success: true, files: [file] })
  wrapper = shallowMount(FileManager, { global: { plugins: [pinia], stubs: {
    FilePreviewDialog: { name: 'FilePreviewDialog', props: ['fileId', 'fileName', 'accountId'], template: '<div />' },
    ArchiveDialog: { name: 'ArchiveDialog', props: ['fileId', 'fileName'], template: '<div />' },
  } } })
  await flushPromises()
  return { view: wrapper, store }
}

it('opens archive operations for the file selected in preview', async () => {
  const { view } = await render()
  view.findComponent({ name: 'FileTable' }).vm.$emit('preview', file)
  await flushPromises()
  const preview = view.findComponent({ name: 'FilePreviewDialog' })
  expect(preview.props('fileId')).toBe('archive')
  preview.vm.$emit('openArchive', { fileId: file.id, fileName: file.name })
  await flushPromises()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(false)
  expect(view.findComponent({ name: 'ArchiveDialog' }).props()).toMatchObject({ fileId: 'archive', fileName: 'archive.zip' })
})

it('closes preview when the selected account changes', async () => {
  const { view, store } = await render()
  view.findComponent({ name: 'FileTable' }).vm.$emit('preview', file)
  await flushPromises()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(true)
  store.currentAccount = { ...store.currentAccount!, id: 'different-account' }
  await flushPromises()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(false)
  expect(view.findComponent({ name: 'ArchiveDialog' }).exists()).toBe(false)
})

it('rejects unsupported files even if an entry point emits a preview request', async () => {
  const { view } = await render()
  view.findComponent({ name: 'FileTable' }).vm.$emit('preview', { ...file, name: 'program.exe' })
  await flushPromises()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(false)
  expect(api.warning).toHaveBeenCalledWith('当前文件或网盘暂不支持在线预览')
})
