// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount, FileItem } from '@shared/types'

const api = vi.hoisted(() => ({ listAccounts: vi.fn(), checkAccount: vi.fn(), deleteAccount: vi.fn(), getAccountMembership: vi.fn(),
  listFiles: vi.fn(), batchShare: vi.fn(), batchTransfer: vi.fn(), cloudTransfer: vi.fn(), subscriptionList: vi.fn(),
  subscriptionAdd: vi.fn(), subscriptionToggle: vi.fn(), subscriptionRemove: vi.fn(), subscriptionRunNow: vi.fn(),
  shareList: vi.fn(), shareDelete: vi.fn(), shareCancel: vi.fn(), transferList: vi.fn(), transferDelete: vi.fn(),
  searchFiles: vi.fn(), getAccountQuota: vi.fn(), getAllSettings: vi.fn(), setSetting: vi.fn(), getClipboardMonitor: vi.fn(),
  setClipboardMonitor: vi.fn(), getGlobalShortcuts: vi.fn(), setGlobalShortcuts: vi.fn(), searchSourcesList: vi.fn(),
  tgChannelsList: vi.fn(), crawlerSourcesList: vi.fn(), kkSourcesList: vi.fn(), linkVerify: vi.fn(), openExternal: vi.fn(),
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), push: vi.fn(), replace: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({ ElMessageBox: api }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: api.push, replace: api.replace }), useRoute: () => ({ query: {} }) }))
import { useAccountStore } from '../stores/account'
import BatchShare from './BatchShare.vue'
import BatchTransfer from './BatchTransfer.vue'
import CloudTransfer from './CloudTransfer.vue'
import ShareLinks from './ShareLinks.vue'
import TransferRecords from './TransferRecords.vue'
import GlobalSearch from './GlobalSearch.vue'
import Dashboard from './Dashboard.vue'
import Settings from './Settings.vue'
import AccountManager from './AccountManager.vue'
import ResourceSearch from './ResourceSearch.vue'

const accounts = ['a', 'b'].map(id => ({ id, platform: 'quark', nickname: id, loginType: 'cookie', status: 'active', createdAt: 0, updatedAt: 0 })) as Omit<DriveAccount, 'credential'>[]
function file(id: string, accountId = 'a', isDir = false): FileItem {
  return { id, accountId, platform: 'quark', name: `${id}.txt`, isDir, parentId: '0', size: 7, createdAt: 0, updatedAt: 1 }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const views: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
function model(view: VueWrapper): Record<string, any> { return view.vm as unknown as Record<string, any> }
function render(component: Parameters<typeof shallowMount>[0]) {
  const view = shallowMount(component, { global: { plugins: [pinia], stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  views.push(view)
  return view
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__APP_VERSION__', 'fixture')
  localStorage.clear()
  pinia = createPinia(); setActivePinia(pinia)
  useAccountStore().accounts = structuredClone(accounts)
  api.listAccounts.mockResolvedValue({ success: true, accounts: structuredClone(accounts) })
  api.listFiles.mockImplementation(async (id: string) => ({ success: true, files: [file(`${id}-file`, id)], parentId: '0', hasMore: false }))
  for (const method of ['batchShare', 'batchTransfer', 'cloudTransfer', 'shareDelete', 'transferDelete', 'shareCancel', 'setSetting', 'subscriptionAdd', 'subscriptionToggle', 'subscriptionRemove', 'subscriptionRunNow'] as const) api[method].mockResolvedValue({ success: true })
  api.subscriptionList.mockResolvedValue({ success: true, subscriptions: [] })
  api.shareList.mockResolvedValue({ success: true, links: [{ id: 'one', status: 'active' }, { id: 'two', status: 'active' }] })
  api.transferList.mockResolvedValue({ success: true, records: [{ id: 'one' }, { id: 'two' }] })
  api.confirm.mockResolvedValue('confirm')
  api.getAllSettings.mockResolvedValue({ success: true, settings: {} })
  api.getClipboardMonitor.mockResolvedValue({ success: true, enabled: true })
  api.getGlobalShortcuts.mockResolvedValue({ success: true, enabled: true })
  api.searchSourcesList.mockResolvedValue({ success: true, sources: [] })
  api.tgChannelsList.mockResolvedValue({ success: true, channels: [] })
  api.crawlerSourcesList.mockResolvedValue({ success: true, sources: [] })
  api.kkSourcesList.mockResolvedValue({ success: true, sources: [] })
  api.getAccountMembership.mockResolvedValue({ success: false, error: 'fixture unavailable' })
})
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.unstubAllGlobals() })

describe('batch and cloud operations', () => {
  it('loads a preselected account and clears share selection when the account changes', async () => {
    const view = render(BatchShare); await flushPromises()
    expect(api.listFiles).toHaveBeenCalledWith('a', '0')
    const vm = model(view)
    vm.onToggle(vm.files[0]); expect(vm.selectedFiles).toHaveLength(1)
    const selects = view.findAllComponents({ name: 'ElSelect' })
    selects[1].vm.$emit('update:modelValue', 'b'); await flushPromises()
    expect(vm.selectedFiles).toHaveLength(0)
    expect(vm.files[0].accountId).toBe('b')
  })

  it('does not display late directory results from an old share account', async () => {
    const old = deferred<unknown>()
    api.listFiles.mockImplementation((id: string) => id === 'a' ? old.promise : Promise.resolve({ success: true, files: [file('new', 'b')] }))
    const vm = model(render(BatchShare)); await flushPromises()
    vm.selectedAccountId = 'b'; await flushPromises()
    old.resolve({ success: true, files: [file('stale')] }); await flushPromises()
    expect(vm.files.map((item: FileItem) => item.id)).toEqual(['new'])
  })

  it('keeps failed individual shares selected and submits all to the original account', async () => {
    const vm = model(render(BatchShare)); await flushPromises()
    vm.selectedFiles = [file('one'), file('two')]; vm.shareMode = 'separate'
    api.batchShare.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: 'fixture failure' })
    await vm.onSubmit()
    expect(api.batchShare.mock.calls.map(call => call[0])).toEqual(['a', 'a'])
    expect(vm.selectedFiles.map((item: FileItem) => item.id)).toEqual(['two'])
  })

  it('parses legacy passwords, preserves case-sensitive IDs, and uses the selected target', async () => {
    const vm = model(render(BatchTransfer)); await flushPromises()
    expect(api.listFiles).toHaveBeenCalledWith('a', '0')
    vm.platform = 'baidu'; await flushPromises(); vm.selectedAccountId = 'baidu-account'
    vm.bulkText = 'https://pan.baidu.com/share/init?surl=abcDEF 提取码: a1B2\nhttps://pan.baidu.com/s/1ABCdef'
    await flushPromises(); await vm.onSubmit()
    expect(api.batchTransfer).toHaveBeenCalledWith('baidu-account', [
      { url: 'https://pan.baidu.com/s/1abcDEF', password: 'a1B2' }, { url: 'https://pan.baidu.com/s/1ABCdef', password: undefined },
    ], undefined, undefined, undefined)
  })

  it('allows a corrected extraction password after failed verification', async () => {
    const vm = model(render(BatchTransfer)); await flushPromises()
    vm.bulkText = 'https://pan.quark.cn/s/abc 提取码: bad1'; await flushPromises()
    api.linkVerify.mockResolvedValueOnce({ success: true, results: [{ url: 'https://pan.quark.cn/s/abc', valid: false }] })
    await vm.onVerifyLinks(); expect(vm.validLinks).toHaveLength(0)
    vm.bulkText = 'https://pan.quark.cn/s/abc 提取码: good'; await flushPromises()
    expect(vm.validLinks).toHaveLength(1)
  })

  it('passes parsed subscription links and the selected target to the subscription panel', async () => {
    const view = render(BatchTransfer)
    const vm = model(view); await flushPromises()
    vm.bulkText = 'https://pan.quark.cn/s/abc 提取码: a1B2'; await flushPromises()
    expect(view.findComponent({ name: 'ShareSubscriptionsPanel' }).props()).toMatchObject({
      accountId: 'a', platform: 'quark', targetDirId: '0', targetDirPath: '/', links: [{ url: 'https://pan.quark.cn/s/abc', password: 'a1B2' }],
    })
  })

  it('submits selected migration IDs and blocks placing a folder inside itself', async () => {
    const vm = model(render(CloudTransfer)); await flushPromises()
    vm.toggleSource(file('one')); await vm.submitTransfer()
    expect(api.cloudTransfer).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: 'a', targetAccountId: 'b', files: [expect.objectContaining({ fileId: 'one', fileSize: 7 })], conflictPolicy: 'rename' }))
    vm.targetAccountId = 'a'; await flushPromises()
    vm.selectedFiles = [file('folder', 'a', true)]; vm.targetNav = [{ id: '0', name: 'root' }, { id: 'folder', name: 'folder' }]
    await vm.submitTransfer(); expect(api.cloudTransfer).toHaveBeenCalledTimes(1)
    expect(api.warning).toHaveBeenCalledWith('不能把文件夹迁移到自身或其子目录')
  })
})

describe('records and search', () => {
  it.each([[ShareLinks, 'shareDelete', 'links'], [TransferRecords, 'transferDelete', 'records']] as const)('keeps failed deletions visible in %s', async (component, method, collection) => {
    const vm = model(render(component)); await flushPromises()
    vm.onSelectionChange([...vm[collection]])
    api[method].mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false })
    await vm.onBatchDelete()
    expect(vm[collection].map((row: { id: string }) => row.id)).toEqual(['two'])
    expect(vm.selectedRows.map((row: { id: string }) => row.id)).toEqual(['two'])
    expect(api.error).toHaveBeenCalledWith('1 条记录删除失败，请重试')
  })

  it('does not mark a remote share cancelled when the IPC operation fails', async () => {
    const vm = model(render(ShareLinks)); await flushPromises()
    api.shareCancel.mockResolvedValueOnce({ success: false, error: 'fixture remote error' })
    const row = vm.links[0]; await vm.onCancel(row)
    expect(row.status).toBe('active'); expect(api.error).toHaveBeenCalledWith('fixture remote error')
  })

  it('retains successful account search results alongside provider errors', async () => {
    api.searchFiles.mockImplementation(async (id: string) => id === 'a' ? { success: true, files: [file('found')] } : { success: false, error: 'fixture expired' })
    const vm = model(render(GlobalSearch)); await flushPromises()
    vm.keyword = 'report'; vm.minSizeMb = 2; await vm.runSearch()
    expect(api.searchFiles).toHaveBeenCalledWith('a', 'report', expect.objectContaining({ minSize: 2 * 1024 * 1024 }))
    expect(vm.results).toHaveLength(1); expect(vm.failures[0].error).toBe('fixture expired')
    expect(vm.history[0].failureCount).toBe(1)
  })

  it('keeps the latest search results when an earlier search finishes later', async () => {
    const old = deferred<unknown>()
    api.searchFiles.mockImplementation((_id: string, keyword: string) => keyword === 'old' ? old.promise : Promise.resolve({ success: true, files: [file('new')] }))
    const vm = model(render(GlobalSearch)); await flushPromises()
    vm.keyword = 'old'; const earlier = vm.runSearch()
    vm.keyword = 'new'; await vm.runSearch()
    old.resolve({ success: true, files: [file('old')] }); await earlier
    expect(vm.results.every((item: FileItem) => item.id === 'new')).toBe(true)
    expect(vm.history[0].query.keyword).toBe('new')
  })
})

describe('settings and account overview', () => {
  it('never reports success when saving a setting is rejected by IPC', async () => {
    const vm = model(render(Settings)); await flushPromises()
    api.setSetting.mockResolvedValueOnce({ success: false, error: 'fixture disk error' })
    await vm.onSave()
    expect(api.success).not.toHaveBeenCalledWith('设置已保存')
    expect(api.error).toHaveBeenCalledWith(expect.stringContaining('fixture disk error'))
    expect(vm.saving).toBe(false)
  })

  it('persists normalized settings and reflects a disabled shortcut response', async () => {
    const vm = model(render(Settings)); await flushPromises()
    vm.form.quarkPageSize = 9999; await vm.onSave()
    expect(api.setSetting).toHaveBeenCalledWith('quarkPageSize', '500')
    expect(api.success).toHaveBeenCalledWith('设置已保存')
    api.setGlobalShortcuts.mockResolvedValueOnce({ success: true, enabled: false })
    await vm.onGlobalShortcutsToggle(false); expect(vm.globalShortcutsEnabled).toBe(false)
  })

  it('checks the selected account and keeps failed account deletion in the store', async () => {
    const vm = model(render(AccountManager)); await flushPromises()
    api.checkAccount.mockResolvedValueOnce({ success: true, status: 'active' })
    await vm.onCheck(accounts[0]); expect(api.checkAccount).toHaveBeenCalledWith('a')
    api.deleteAccount.mockResolvedValueOnce({ success: false, error: 'fixture busy' })
    vm.onDelete(accounts[0]); await flushPromises()
    expect(useAccountStore().accounts).toHaveLength(2)
    expect(api.error).toHaveBeenCalledWith('fixture busy')
  })

  it('calculates quota totals while preserving unavailable provider results', async () => {
    api.getAccountQuota.mockResolvedValue({ success: true, quotas: [{ accountId: 'a', platform: 'quark', nickname: 'a', quota: { used: 25, total: 100 } }, { accountId: 'b', platform: 'webdav', nickname: 'b', quota: null, error: 'unsupported' }] })
    const vm = model(render(Dashboard)); await flushPromises()
    expect(vm.totalUsed).toBe(25); expect(vm.overallPercent).toBe(25); expect(vm.unsupportedCount).toBe(1)
  })

  it('loads resource sites and ignores cancelled or subframe failures', async () => {
    api.searchSourcesList.mockResolvedValueOnce({ success: true, sources: [{ id: 'site', name: 'fixture', url: 'https://example.test', capabilities: '["search"]' }] })
    const vm = model(render(ResourceSearch)); await flushPromises()
    vm.selectSite(vm.sites[0]); expect(vm.currentUrl).toBe('https://example.test')
    vm.onFailLoad({ errorCode: -3 }); expect(vm.loadError).toBe('')
    vm.onFailLoad({ errorCode: -2, isMainFrame: true, errorDescription: 'fixture offline' }); expect(vm.loadError).toBe('fixture offline')
  })
})
