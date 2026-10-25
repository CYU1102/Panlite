// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useRouter } from 'vue-router'

const api = vi.hoisted(() => ({ listFiles: vi.fn(), listAccounts: vi.fn(), resolveEntry: vi.fn(), searchFiles: vi.fn(), deleteFiles: vi.fn(), confirm: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('../api/catalog', () => ({ catalogApi: { resolveEntry: api.resolveEntry } }))
vi.mock('vue-router', async () => {
  const { ref } = await import('vue')
  const currentRoute = ref({ query: {} })
  return { useRouter: () => ({ push: vi.fn(), currentRoute }) }
})
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { warning: api.warning, error: api.error, success: api.success } }))
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({ ElMessageBox: { confirm: api.confirm } }))
import FileManager from './FileManager.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined
  useRouter().currentRoute.value.query = {}
  vi.resetAllMocks(); localStorage.clear()
})
const file: FileItem = { id: 'archive', name: 'archive.zip', accountId: 'account', platform: 'quark', parentId: '0', isDir: false, size: 42, createdAt: 0, updatedAt: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const searchFile = { ...file, id: 'search-result', name: 'result.txt' }
const listing = (files: FileItem[]) => ({ success: true, files, parentId: '0', hasMore: false })

async function render(options: { keyword?: string; listResponse?: Promise<unknown>; searchResponse?: Promise<unknown> } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useAppStore()
  store.currentAccount = { id: 'account', platform: 'quark', nickname: 'Account' } as NonNullable<typeof store.currentAccount>
  if (options.keyword) store.startSearch(options.keyword)
  api.listFiles.mockReturnValue(options.listResponse || Promise.resolve(listing([file])))
  api.searchFiles.mockReturnValue(options.searchResponse || Promise.resolve({ success: true, files: [searchFile] }))
  api.deleteFiles.mockResolvedValue({ success: true })
  api.confirm.mockResolvedValue('confirm')
  wrapper = shallowMount(FileManager, { global: { plugins: [pinia], stubs: {
    FilePreviewDialog: { name: 'FilePreviewDialog', props: ['fileId', 'fileName', 'accountId'], template: '<div />' },
    ArchiveDialog: { name: 'ArchiveDialog', props: ['fileId', 'fileName'], template: '<div />' },
  } } })
  await flushPromises()
  return { view: wrapper, store, pinia }
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

it('keeps all 100000 selected files in the batch operation and synchronizes clearing to the table', async () => {
  const files = Array.from({ length: 100_000 }, (_, index) => ({ ...file, id: `large-${index + 1}`, name: `file-${index + 1}.txt` }))
  const { view, store } = await render({ listResponse: Promise.resolve(listing(files)) })
  const table = view.findComponent({ name: 'FileTable' })
  expect(table.props('selectionContext')).toContain('account')
  table.vm.$emit('selectionChange', files); await flushPromises()
  expect(store.selectedCount).toBe(100_000)
  expect(table.props('selectedFiles')).toHaveLength(100_000)
  expect((table.props('selectedFiles') as FileItem[])[99_999].id).toBe('large-100000')
  await (view.vm as unknown as { onBatchDelete: () => Promise<void> }).onBatchDelete()
  await flushPromises()
  const [accountId, deleted] = api.deleteFiles.mock.calls[0] as [string, string[]]
  expect(accountId).toBe('account')
  expect(deleted).toHaveLength(100_000)
  expect(deleted[99_999]).toBe('large-100000')
  expect(table.props('files')).toEqual([])
  expect(table.props('selectedFiles')).toEqual([])
  expect(store.selectedCount).toBe(0)
}, 20_000)

it('rejects unsupported files even if an entry point emits a preview request', async () => {
  const { view } = await render()
  view.findComponent({ name: 'FileTable' }).vm.$emit('preview', { ...file, name: 'program.exe' })
  await flushPromises()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(false)
  expect(api.warning).toHaveBeenCalledWith('当前文件或网盘暂不支持在线预览')
})


it('restores and persists file table density across page visits', async () => {
  localStorage.setItem('panlite:file-density', 'compact')
  const { view } = await render()
  expect(view.findComponent({ name: 'FileTable' }).props('density')).toBe('compact')
  await view.findAll('.density-control button').find(button => button.text() === '舒适')!.trigger('click')
  expect(localStorage.getItem('panlite:file-density')).toBe('comfortable')
  expect(view.findComponent({ name: 'FileTable' }).props('density')).toBe('comfortable')
  localStorage.removeItem('panlite:file-density')
})

it('restores the current directory and clears selection and cache when search is cleared', async () => {
  const { view, store } = await render()
  const table = view.findComponent({ name: 'FileTable' })
  table.vm.$emit('selectionChange', [file]); await flushPromises()
  expect(store.selectedCount).toBe(1)
  api.searchFiles.mockResolvedValueOnce({ success: true, files: [searchFile], fromCache: true })
  store.startSearch('result'); await flushPromises()
  expect(store.selectedCount).toBe(0)
  expect(table.props('files')).toEqual([searchFile])
  await view.get('[aria-label="清除文件搜索"]').trigger('click'); await flushPromises()
  expect(api.listFiles).toHaveBeenCalledTimes(2)
  expect(table.props('files')).toEqual([file])
  expect(view.get('.file-footer').text()).toContain('云端目录')
  expect(view.get('.file-footer').text()).not.toContain('离线缓存')
})

it('ignores an old account search without releasing the new account loading state', async () => {
  const { view, store } = await render()
  const search = deferred<unknown>(), nextDirectory = deferred<unknown>()
  api.searchFiles.mockReturnValueOnce(search.promise)
  store.startSearch('result'); await flushPromises()
  api.listFiles.mockReturnValueOnce(nextDirectory.promise)
  store.setAccount({ ...store.currentAccount!, id: 'other-account' }); await flushPromises()
  const table = view.findComponent({ name: 'FileTable' })
  search.resolve({ success: true, files: [searchFile] }); await flushPromises()
  expect(table.props('files')).toEqual([])
  expect(table.props('loading')).toBe(true)
  expect(api.success).not.toHaveBeenCalled()
  const nextFile = { ...file, accountId: 'other-account', id: 'other-file' }
  nextDirectory.resolve(listing([nextFile])); await flushPromises()
  expect(table.props('files')).toEqual([nextFile])
  expect(table.props('loading')).toBe(false)
})

it('resumes an active search when returning to the file page', async () => {
  const { view, store } = await render({ keyword: 'result' })
  expect(store.isSearching).toBe(true)
  expect(api.listFiles).not.toHaveBeenCalled()
  expect(api.searchFiles).toHaveBeenCalledWith('account', 'result', {})
  expect(view.findComponent({ name: 'FileTable' }).props('files')).toEqual([searchFile])
})

it('executes the persisted search again after leaving and remounting the page', async () => {
  const { view, store, pinia } = await render()
  store.startSearch('result'); await flushPromises()
  view.unmount(); wrapper = undefined
  api.searchFiles.mockClear()
  api.listFiles.mockClear()
  wrapper = shallowMount(FileManager, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(api.searchFiles).toHaveBeenCalledWith('account', 'result', {})
  expect(api.listFiles).not.toHaveBeenCalled()
  expect(wrapper.findComponent({ name: 'FileTable' }).props('files')).toEqual([searchFile])
})

it('keeps live catalog confirmation when moving to another account and parent', async () => {
  const { view, store } = await render()
  const nextAccount = { ...store.currentAccount!, id: 'catalog-account', status: 'active' }
  const target = { ...file, id: 'catalog-file', accountId: nextAccount.id, parentId: 'catalog-parent' }
  api.resolveEntry.mockResolvedValue({ success: true, entry: {
    accountId: nextAccount.id, fileId: target.id, parentId: target.parentId, path: '/folder/archive.zip',
  } })
  api.listAccounts.mockResolvedValue({ success: true, accounts: [nextAccount] })
  api.listFiles.mockClear().mockResolvedValue({ ...listing([target]), parentId: target.parentId })
  useRouter().currentRoute.value.query = { from: 'catalog', accountId: nextAccount.id, fileId: target.id }
  await flushPromises()
  expect(store.currentAccount?.id).toBe(nextAccount.id)
  expect(store.currentPath).toBe(target.parentId)
  expect(api.listFiles).toHaveBeenCalledTimes(1)
  expect(api.listFiles).toHaveBeenCalledWith(nextAccount.id, target.parentId, false)
  expect(view.findComponent({ name: 'FileTable' }).props('files')).toEqual([target])
  expect(view.text()).toContain('已在线确认')
})

it('ignores a directory response that arrives after a newer search', async () => {
  const directory = deferred<unknown>()
  const { view, store } = await render({ listResponse: directory.promise })
  store.startSearch('result'); await flushPromises()
  const table = view.findComponent({ name: 'FileTable' })
  expect(table.props('files')).toEqual([searchFile])
  directory.resolve({ ...listing([file]), cached: true, cacheTime: 42, offlineReason: 'stale' }); await flushPromises()
  expect(store.isSearching).toBe(true)
  expect(table.props('files')).toEqual([searchFile])
  expect(table.props('loading')).toBe(false)
  expect(view.get('.file-footer').text()).toContain('网盘搜索结果')
})

it('ignores late keyword failures and accepts only the latest filter request', async () => {
  const { view, store } = await render()
  const oldSearch = deferred<unknown>(), newSearch = deferred<unknown>()
  api.searchFiles.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(newSearch.promise)
  store.startSearch('old'); await flushPromises()
  store.startSearch('new'); await flushPromises()
  oldSearch.reject(new Error('old request failed')); await flushPromises()
  const table = view.findComponent({ name: 'FileTable' })
  expect(api.error).not.toHaveBeenCalled()
  expect(table.props('loading')).toBe(true)
  newSearch.resolve({ success: true, files: [searchFile] }); await flushPromises()
  expect(table.props('files')).toEqual([searchFile])
  const filterSearch = deferred<unknown>()
  api.searchFiles.mockReturnValueOnce(filterSearch.promise)
  const vm = view.vm as unknown as { onApplySearchFilters: (filters: { fileTypes: string[] }) => void }
  vm.onApplySearchFilters({ fileTypes: ['document'] }); await flushPromises()
  expect(api.searchFiles).toHaveBeenLastCalledWith('account', 'new', { fileTypes: ['document'] })
  store.clearSearch(); await flushPromises()
  filterSearch.resolve({ success: true, files: [searchFile], fromCache: true }); await flushPromises()
  expect(table.props('files')).toEqual([file])
  expect(view.get('.file-footer').text()).toContain('云端目录')
})

it('invalidates a request even if the account switches away and back before the next tick', async () => {
  const { view, store } = await render()
  const oldSearch = deferred<unknown>()
  api.searchFiles.mockReturnValueOnce(oldSearch.promise)
  store.startSearch('result'); await flushPromises()
  const original = store.currentAccount!
  store.setAccount({ ...original, id: 'other-account' })
  store.setAccount(original)
  store.startSearch('result')
  await flushPromises()
  const latestFile = { ...searchFile, id: 'latest-file' }
  api.searchFiles.mockResolvedValueOnce({ success: true, files: [latestFile] })
  store.refreshKey++; await flushPromises()
  oldSearch.resolve({ success: true, files: [searchFile] }); await flushPromises()
  expect(view.findComponent({ name: 'FileTable' }).props('files')).toEqual([latestFile])
})

it('clears files, loading and selection on deselection of the account and ignores a late response', async () => {
  const { view, store } = await render()
  const search = deferred<unknown>()
  api.searchFiles.mockReturnValueOnce(search.promise)
  view.findComponent({ name: 'FileTable' }).vm.$emit('selectionChange', [file]); await flushPromises()
  store.startSearch('result'); await flushPromises()
  store.setAccount(null); await flushPromises()
  search.resolve({ success: true, files: [searchFile] }); await flushPromises()
  expect(view.findComponent({ name: 'FileTable' }).exists()).toBe(false)
  expect(store.selectedCount).toBe(0)
  expect(api.success).not.toHaveBeenCalled()
})

it('does not apply search results or toast after the page unmounts', async () => {
  const search = deferred<unknown>()
  const { view, store } = await render({ keyword: 'result', searchResponse: search.promise })
  view.unmount(); wrapper = undefined
  store.selectedCount = 3
  search.resolve({ success: true, files: [searchFile] }); await flushPromises()
  expect(api.success).not.toHaveBeenCalled()
  expect(store.selectedCount).toBe(3)
})

it('rejects file operations and stale selection events for another account', async () => {
  const { view, store } = await render()
  const table = view.findComponent({ name: 'FileTable' })
  const foreignFile = { ...file, accountId: 'other-account' }
  table.vm.$emit('selectionChange', [foreignFile])
  table.vm.$emit('delete', foreignFile)
  table.vm.$emit('preview', foreignFile)
  await flushPromises()
  expect(store.selectedCount).toBe(0)
  expect(api.confirm).not.toHaveBeenCalled()
  expect(api.deleteFiles).not.toHaveBeenCalled()
  expect(view.findComponent({ name: 'FilePreviewDialog' }).exists()).toBe(false)
  expect(api.warning).toHaveBeenCalledWith('文件列表或账号已变化，请重新选择文件')
})

it('cancels single-file deletion when the account changes during confirmation', async () => {
  const { view, store } = await render()
  const confirmation = deferred<unknown>()
  api.confirm.mockReturnValueOnce(confirmation.promise)
  view.findComponent({ name: 'FileTable' }).vm.$emit('delete', file); await flushPromises()
  store.setAccount({ ...store.currentAccount!, id: 'other-account' }); await flushPromises()
  confirmation.resolve('confirm'); await flushPromises()
  expect(api.deleteFiles).not.toHaveBeenCalled()
})

it('does not remove a new account file when an old account deletion finishes', async () => {
  const { view, store } = await render()
  const deletion = deferred<unknown>()
  api.deleteFiles.mockReturnValueOnce(deletion.promise)
  view.findComponent({ name: 'FileTable' }).vm.$emit('delete', file); await flushPromises()
  expect(api.deleteFiles).toHaveBeenCalledWith('account', [file.id])
  const nextFile = { ...file, accountId: 'other-account' }
  api.listFiles.mockResolvedValueOnce(listing([nextFile]))
  store.setAccount({ ...store.currentAccount!, id: 'other-account' }); await flushPromises()
  deletion.resolve({ success: true }); await flushPromises()
  expect(view.findComponent({ name: 'FileTable' }).props('files')).toEqual([nextFile])
  expect(api.success).not.toHaveBeenCalled()
})

it('keeps batch deletion bound to the selection shown in its confirmation', async () => {
  const { view, store } = await render()
  const secondFile = { ...file, id: 'second-file' }
  api.listFiles.mockResolvedValueOnce(listing([file, secondFile])); store.refreshKey++; await flushPromises()
  const table = view.findComponent({ name: 'FileTable' })
  table.vm.$emit('selectionChange', [file]); await flushPromises()
  const confirmation = deferred<unknown>()
  api.confirm.mockReturnValueOnce(confirmation.promise)
  const vm = view.vm as unknown as { onBatchDelete: () => Promise<void> }
  const pendingDeletion = vm.onBatchDelete(); await flushPromises()
  table.vm.$emit('selectionChange', [secondFile]); await flushPromises()
  confirmation.resolve('confirm'); await pendingDeletion; await flushPromises()
  expect(api.deleteFiles).toHaveBeenCalledWith('account', [file.id])
  expect(table.props('files')).toEqual([secondFile])
  expect(store.selectedCount).toBe(0)
})

it('cancels batch deletion when the account changes during confirmation', async () => {
  const { view, store } = await render()
  view.findComponent({ name: 'FileTable' }).vm.$emit('selectionChange', [file]); await flushPromises()
  const confirmation = deferred<unknown>()
  api.confirm.mockReturnValueOnce(confirmation.promise)
  const vm = view.vm as unknown as { onBatchDelete: () => Promise<void> }
  const pendingDeletion = vm.onBatchDelete(); await flushPromises()
  store.setAccount({ ...store.currentAccount!, id: 'other-account' }); await flushPromises()
  confirmation.resolve('confirm'); await pendingDeletion
  expect(api.deleteFiles).not.toHaveBeenCalled()
})
