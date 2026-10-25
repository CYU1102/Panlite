// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { isProxy } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DriveAccount, FileItem, UploadParams } from '@shared/types'

const api = vi.hoisted(() => ({ listFiles: vi.fn(), copyFiles: vi.fn(), moveFiles: vi.fn(), batchTransfer: vi.fn(), batchShare: vi.fn(),
  linkVerify: vi.fn(), selectDownloadDir: vi.fn(), downloadFiles: vi.fn(), selectUploadFiles: vi.fn(), uploadFiles: vi.fn(),
  archiveCompress: vi.fn(), archiveList: vi.fn(), archiveExtract: vi.fn(), aggregateSearch: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
import { useAccountStore } from '../stores/account'
import { useAppStore } from '../stores/app'
import CopyDialog from './CopyDialog.vue'
import MoveDialog from './MoveDialog.vue'
import TransferDialog from './TransferDialog.vue'
import ShareDialog from './ShareDialog.vue'
import DownloadDialog from './DownloadDialog.vue'
import UploadDialog from './UploadDialog.vue'
import CompressDialog from './CompressDialog.vue'
import ArchiveDialog from './ArchiveDialog.vue'
import QuickSearchDialog from './QuickSearchDialog.vue'
import SearchFilterDialog from './SearchFilterDialog.vue'

const account = { id: 'account', platform: 'quark', loginType: 'cookie', nickname: 'fixture', status: 'active', createdAt: 0, updatedAt: 0 } as Omit<DriveAccount, 'credential'>
const file = { id: 'file', accountId: account.id, platform: 'quark', name: 'fixture.txt', isDir: false, size: 5, parentId: '0', createdAt: 0, updatedAt: 0 } as FileItem
const views: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
function render(component: Parameters<typeof shallowMount>[0], props: Record<string, unknown> = {}) {
  const view = shallowMount(component, { props: { modelValue: true, ...props }, global: { plugins: [pinia] } })
  views.push(view); return view
}
function model(view: VueWrapper): Record<string, any> { return view.vm as unknown as Record<string, any> }
beforeEach(() => {
  vi.clearAllMocks()
  pinia = createPinia(); setActivePinia(pinia)
  useAccountStore().accounts = [account]
  useAppStore().setAccount(account)
  api.listFiles.mockResolvedValue({ success: true, files: [{ ...file, id: 'folder', isDir: true }] })
  for (const method of ['copyFiles', 'moveFiles', 'batchTransfer', 'batchShare', 'downloadFiles', 'uploadFiles', 'archiveCompress', 'archiveExtract'] as const) api[method].mockResolvedValue({ success: true, taskId: 'task' })
  api.selectDownloadDir.mockResolvedValue({ success: true, dirPath: 'D:/fixture-output' })
  api.selectUploadFiles.mockResolvedValue({ success: true, files: [{ localPath: 'D:/fixture.txt', fileName: 'fixture.txt', fileSize: 5 }] })
})
afterEach(() => views.splice(0).forEach(view => view.unmount()))

it('resolves the lazy copy-tree root without an invalid file-list IPC request', async () => {
  const view = render(CopyDialog, { account, files: [file], currentDirId: '0' }); const vm = model(view)
  const resolve = vi.fn()
  await vm.loadNode({ level: 0, data: undefined }, resolve)
  expect(resolve).toHaveBeenCalledWith([expect.objectContaining({ id: '0' })]); expect(api.listFiles).not.toHaveBeenCalled()
  await vm.loadNode({ level: 1, data: { id: '0' } }, resolve)
  vm.onNodeClick({ id: 'folder' }); await vm.startCopy()
  expect(api.copyFiles).toHaveBeenCalledWith('account', ['file'], 'folder'); expect(view.emitted('success')).toHaveLength(1)
})

it('blocks selecting the folder being moved and uses the chosen destination', async () => {
  const view = render(MoveDialog, { files: [{ ...file, id: 'self', isDir: true }] }); await flushPromises(); const vm = model(view)
  vm.onFolderClick({ ...file, id: 'self', isDir: true }); expect(vm.currentFolder.id).toBe('0')
  vm.onFolderClick({ ...file, id: 'destination', isDir: true }); await flushPromises(); await vm.onConfirm()
  expect(api.moveFiles).toHaveBeenCalledWith('account', ['self'], 'destination')
})

it('keeps transfer verification attached to the originally selected account and directory', async () => {
  const view = render(TransferDialog, { initialLinks: [{ url: 'https://pan.quark.cn/s/abc', password: 'a1B2' }], initialTargetDirId: 'folder', initialTargetPath: '/folder' })
  await flushPromises(); const vm = model(view)
  const resolveRoot = vi.fn(); await vm.loadDirectoryNode({ level: 0 }, resolveRoot)
  expect(resolveRoot).toHaveBeenCalledWith([expect.objectContaining({ id: '0' })])
  vm.verifyFirst = true
  api.linkVerify.mockImplementationOnce(async () => { vm.selectedAccountId = 'different'; vm.targetDirId = 'other'; return { success: true, results: [{ url: 'https://pan.quark.cn/s/abc', valid: true }] } })
  await vm.onConfirm()
  expect(api.batchTransfer).toHaveBeenCalledWith('account', [{ url: 'https://pan.quark.cn/s/abc', password: 'a1B2' }], 'folder', '/folder', { autoShare: false })
})

it('submits share metadata and preserves the dialog when the task is rejected', async () => {
  api.batchShare.mockResolvedValueOnce({ success: false, error: 'fixture denied' })
  const view = render(ShareDialog, { files: [{ ...file, raw: { token: 'fixture-file-token' } }] }); const vm = model(view)
  vm.password = 'a1B2'; await vm.onConfirm()
  expect(api.batchShare).toHaveBeenCalledWith('account', [{ fileId: 'file', name: 'fixture.txt', isDir: false, raw: { token: 'fixture-file-token' } }], { expireDays: 7, password: 'a1B2' })
  expect(view.emitted('success')).toBeUndefined(); expect(api.error).toHaveBeenCalledWith('fixture denied')
})

it('uses selected local upload paths and conflict policy', async () => {
  const view = render(UploadDialog, { account, targetDirId: 'folder', targetDirName: 'folder' }); const vm = model(view)
  await vm.selectFiles(); vm.conflictPolicy = 'skip'; await vm.startUpload()
  expect(api.uploadFiles).toHaveBeenCalledWith({ accountId: 'account', files: [{ localPath: 'D:/fixture.txt', fileName: 'fixture.txt', fileSize: 5 }], targetDirId: 'folder', conflictPolicy: 'skip' })
  expect(view.emitted('success')).toHaveLength(1)
})

it('passes cloneable plain upload metadata across the IPC boundary, retaining folder paths', async () => {
  api.selectUploadFiles.mockResolvedValueOnce({ success: true, files: [{ localPath: 'D:/fixture.txt', fileName: 'fixture.txt', fileSize: 5, relativePath: 'folder/fixture.txt' }] })
  api.uploadFiles.mockImplementationOnce(async (params: UploadParams) => {
    structuredClone(params)
    return { success: true, taskId: 'task' }
  })
  const view = render(UploadDialog, { account, targetDirId: 'folder', targetDirName: 'folder' }); const vm = model(view)
  await vm.selectFiles(); await vm.startUpload()
  const payload = api.uploadFiles.mock.calls[0][0] as UploadParams
  expect(isProxy(payload.files)).toBe(false)
  expect(payload.files.every(item => !isProxy(item))).toBe(true)
  expect(payload.files[0].relativePath).toBe('folder/fixture.txt')
  expect(view.emitted('success')).toHaveLength(1)
  expect(api.error).not.toHaveBeenCalled()
})

it('shows the upload bridge error and retains selected files for retry', async () => {
  api.uploadFiles.mockRejectedValueOnce(new Error('fixture clone failure'))
  const view = render(UploadDialog, { account, targetDirId: 'folder', targetDirName: 'folder' }); const vm = model(view)
  await vm.selectFiles(); await vm.startUpload()
  expect(api.error).toHaveBeenCalledWith('创建上传任务失败: fixture clone failure')
  expect(vm.fileList).toHaveLength(1)
  expect(vm.uploading).toBe(false)
  expect(view.emitted('success')).toBeUndefined()
})

it('requires a download directory and submits its selected conflict policy', async () => {
  const files = [{ fileId: 'file', fileName: 'fixture.txt', fileSize: 5 }]
  const view = render(DownloadDialog, { account, files }); const vm = model(view)
  await vm.startDownload(); expect(api.downloadFiles).not.toHaveBeenCalled()
  await vm.selectDir(); vm.conflictPolicy = 'overwrite'; await vm.startDownload()
  expect(api.downloadFiles).toHaveBeenCalledWith({ accountId: 'account', files, targetDirPath: 'D:/fixture-output', conflictPolicy: 'overwrite' })
})

it('submits archive creation only for a supported account and selection', async () => {
  const vm = model(render(CompressDialog, { account, files: [file], currentDirId: 'folder' }))
  vm.archiveName = 'fixture.zip'; await vm.startCompress()
  expect(api.archiveCompress).toHaveBeenCalledWith('account', ['file'], { format: 'zip', targetDir: 'folder', archiveName: 'fixture.zip' })
})

it('lists an archive and extracts only the selected entries to the local picker destination', async () => {
  api.archiveList.mockResolvedValue({ success: true, meta: { entries: [], files: [], format: 'zip', totalSize: 5 } })
  const vm = model(render(ArchiveDialog, { account, fileId: 'archive', fileName: 'fixture.zip' })); await flushPromises()
  expect(api.archiveList).toHaveBeenCalledWith('account', 'archive', 'fixture.zip', undefined)
  vm.onSelectionChange([{ path: 'folder/file.txt' }]); await vm.onExtractSelected()
  expect(api.archiveExtract).toHaveBeenCalledWith('account', 'archive', 'fixture.zip', { password: undefined, targetDir: 'D:/fixture-output', files: ['folder/file.txt'] })
})

it('reports quick search failure and forwards the selected resource with its password', async () => {
  api.aggregateSearch.mockResolvedValueOnce({ success: false, error: 'fixture unavailable' })
  const view = render(QuickSearchDialog); const vm = model(view); vm.keyword = 'report'; await vm.onSearch()
  expect(api.error).toHaveBeenCalledWith('fixture unavailable'); expect(vm.searching).toBe(false)
  const resource = { title: 'fixture', url: 'https://pan.quark.cn/s/abc', password: 'a1B2', platform: 'quark', source: 'fixture' }
  vm.transferItem(resource); expect(view.emitted('transfer')).toEqual([[resource]])
})

it('does not extend an already applied end date by another day', async () => {
  const end = new Date(2026, 8, 9, 23, 59, 59, 999).getTime()
  const view = render(SearchFilterDialog, { filters: { dateFrom: new Date(2026, 8, 8).getTime(), dateTo: end } })
  const vm = model(view); vm.onApply()
  expect(view.emitted('apply')?.[0]?.[0]).toMatchObject({ dateTo: end })
  vm.minSizeMB = 5; vm.maxSizeMB = 1; vm.onApply()
  expect(view.emitted('apply')).toHaveLength(1)
})
