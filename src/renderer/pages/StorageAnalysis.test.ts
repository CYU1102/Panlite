// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CatalogScope } from '@shared/catalog'
import type { StorageDuplicateGroup, StorageMember, StoragePageQuery, StoragePlan, StorageSummary } from '@shared/storage-analysis'

const api = vi.hoisted(() => ({ summary: vi.fn(), listDirectories: vi.fn(), listLargeFiles: vi.fn(), listDuplicateGroups: vi.fn(), listGroupMembers: vi.fn(), verifyEvidence: vi.fn(), refreshQuotas: vi.fn(), createPlan: vi.fn(), exportPlan: vi.fn() }))
const catalog = vi.hoisted(() => ({ listScopes: vi.fn(), resolveEntry: vi.fn() }))
const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('../api/storage-analysis', () => ({ storageAnalysisApi: api }))
vi.mock('../api/catalog', () => ({ catalogApi: catalog }))
vi.mock('vue-router', () => ({ useRouter: () => router }))
import StorageAnalysis from './StorageAnalysis.vue'

const scope: CatalogScope = { id: 'scope-a', accountId: 'a', accountNickname: '工作盘', platform: 'pan123', rootId: 'root', rootPath: '/资料', status: 'partial', scannedDirectories: 5, pendingDirectories: 2, failedDirectories: 1, entryCount: 20, failures: [{ directoryId: 'bad', path: '/资料/失败', error: '无法读取目录' }], createdAt: 1000, updatedAt: 2000, lastScanAt: 1500, lastCompletedAt: 1000, accountStatus: 'active' }
function member(accountId = 'a'): StorageMember { return { accountId, fileId: 'same', name: '计划.pdf', parentId: 'root', path: `/资料/${accountId}/计划.pdf`, size: 100, isDir: false, fileType: 'document', createdAt: 1000, updatedAt: 1000, indexedAt: 2000, platform: 'pan123', accountNickname: accountId === 'a' ? '工作盘' : '个人盘', accountStatus: 'active', tags: [], favorite: false, collectionIds: [], evidence: null } }
const group: StorageDuplicateGroup = { name: '计划.pdf', displayName: '计划.pdf', size: 100, count: 2, bytes: 200, possibleReleaseBytes: 100, status: 'candidate', evidenceCount: 0, distinctEvidenceCount: 0 }
const summary: StorageSummary = { bytes: 200, fileCount: 2, directoryCount: 1, lastIndexedAt: 2000, generatedAt: 3000, accounts: [{ accountId: 'a', nickname: '工作盘', platform: 'pan123', status: 'active', bytes: 200, fileCount: 2, directoryCount: 1, lastIndexedAt: 2000, quota: { used: 1000, total: 10000, checkedAt: 1000 }, quotaDifference: 800 }], types: [{ fileType: 'document', bytes: 200, fileCount: 2 }], scopes: [{ ...scope, indexedBytes: 200, indexedFiles: 2 }], coverage: { totalScopes: 1, completeScopes: 0, failedDirectories: 1, pendingDirectories: 2 } }
const plan: StoragePlan = { generatedAt: 3000, keep: member('a'), review: [{ ...member('b'), certainty: 'candidate' }], confirmedReleaseBytes: 0, candidateReleaseBytes: 100, notice: '此清单仅供人工核对，不会删除文件。' }
let wrapper: VueWrapper | undefined
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function button(view: VueWrapper, label: string) { const button = view.findAll('button').find(item => item.text() === label); if (!button) throw new Error(`Missing button ${label}`); return button }
async function render() { wrapper = mount(StorageAnalysis); await flushPromises(); return wrapper }
beforeEach(() => {
  vi.resetAllMocks()
  api.summary.mockResolvedValue({ success: true, summary })
  catalog.listScopes.mockResolvedValue({ success: true, scopes: [scope, { ...scope, id: 'scope-b', accountId: 'b', accountNickname: '个人盘' }] })
  api.listDirectories.mockImplementation((query: StoragePageQuery) => Promise.resolve({ success: true, items: [{ accountId: 'a', fileId: 'dir', name: '资料', path: query.page === 2 ? '/第二页' : '/资料', accountNickname: '工作盘', bytes: 200, fileCount: 2, isScopeRoot: false }], total: 73, page: query.page ?? 1, pageSize: query.pageSize ?? 25 }))
  api.listLargeFiles.mockResolvedValue({ success: true, items: [member()], total: 1, page: 1, pageSize: 25 })
  api.listDuplicateGroups.mockResolvedValue({ success: true, items: [group], total: 1, page: 1, pageSize: 25 })
  api.listGroupMembers.mockResolvedValue({ success: true, items: [member(), member('b')], total: 2, page: 1, pageSize: 25 })
  api.verifyEvidence.mockResolvedValue({ success: true, results: [{ accountId: 'a', fileId: 'same', status: 'unavailable', message: '平台未提供受支持的完整内容哈希，仍只作为候选' }] })
  api.refreshQuotas.mockResolvedValue({ success: true, results: [{ accountId: 'a', success: true, message: '已更新' }] })
  api.createPlan.mockResolvedValue({ success: true, plan })
  api.exportPlan.mockResolvedValue({ success: true, cancelled: false, filePath: 'D:\\整理清单.csv' })
  catalog.resolveEntry.mockResolvedValue({ success: true, entry: member() })
  router.push.mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

it('shows failed coverage, quota differences and indexed-byte semantics without remote reads on mount', async () => {
  const view = await render()
  expect(view.text()).toContain('失败目录'); expect(view.text()).toContain('/资料/失败'); expect(view.text()).toContain('无法读取目录')
  expect(view.text()).toContain('差值 +800 B'); expect(view.text()).toContain('文件夹自身的 size 不参与总量')
  expect(api.verifyEvidence).not.toHaveBeenCalled(); expect(api.refreshQuotas).not.toHaveBeenCalled(); expect(catalog.resolveEntry).not.toHaveBeenCalled()
  await button(view, '更新平台容量').trigger('click'); await flushPromises()
  expect(api.refreshQuotas).toHaveBeenCalledExactlyOnceWith({ accountIds: ['a'] })
})

it('applies account, scope and type filters to paginated SQL queries and resets page on filtering', async () => {
  const view = await render()
  await button(view, '下一页').trigger('click'); await flushPromises()
  expect(api.listDirectories).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 25 }))
  expect(view.get('tbody').text()).toContain('/第二页')
  await view.get('select[aria-label="来源账号"]').setValue('a')
  await view.get('select[aria-label="索引范围"]').setValue('scope-a')
  await view.get('select[aria-label="文件类型"]').setValue('document')
  await view.get('form.filters').trigger('submit'); await flushPromises()
  expect(api.summary).toHaveBeenLastCalledWith({ accountIds: ['a'], scopeIds: ['scope-a'], fileTypes: ['document'] })
  expect(api.listDirectories).toHaveBeenLastCalledWith({ accountIds: ['a'], scopeIds: ['scope-a'], fileTypes: ['document'], page: 1, pageSize: 25 })
  await button(view, '大文件排行').trigger('click'); await flushPromises()
  expect(api.listLargeFiles).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['a'], page: 1 }))
  await view.get('select[aria-label="每页数量"]').setValue(50); await flushPromises()
  expect(api.listLargeFiles).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }))
})

it('ignores late summaries and list responses when newer filters finish first', async () => {
  const view = await render(), oldSummary = deferred<unknown>(), oldList = deferred<unknown>()
  api.summary.mockReturnValueOnce(oldSummary.promise); api.listDirectories.mockReturnValueOnce(oldList.promise)
  await view.get('select[aria-label="来源账号"]').setValue('a'); await view.get('form.filters').trigger('submit')
  api.summary.mockResolvedValueOnce({ success: true, summary: { ...summary, bytes: 555 } })
  api.listDirectories.mockResolvedValueOnce({ success: true, items: [{ accountId: 'b', fileId: 'fresh', name: '新结果', path: '/新结果', accountNickname: '个人盘', bytes: 555, fileCount: 2, isScopeRoot: false }], total: 1, page: 1, pageSize: 25 })
  await view.get('select[aria-label="来源账号"]').setValue('b'); await view.get('form.filters').trigger('submit'); await flushPromises()
  oldSummary.resolve({ success: true, summary: { ...summary, bytes: 999 } }); oldList.resolve({ success: true, items: [], total: 0, page: 1, pageSize: 25 }); await flushPromises()
  expect(view.get('tbody').text()).toContain('/新结果'); expect(view.get('.metrics').text()).toContain('555 B'); expect(view.get('.metrics').text()).not.toContain('999 B')
})

it('requires keeper and selected review copies, distinguishes candidate estimates and exports the reviewed selection', async () => {
  const view = await render()
  await button(view, '重复文件候选').trigger('click'); await flushPromises()
  await button(view, '查看副本').trigger('click'); await flushPromises()
  expect(button(view, '生成整理清单').attributes('disabled')).toBeDefined()
  await view.get('input[aria-label="保留 工作盘 /资料/a/计划.pdf"]').setValue(true)
  await view.get('input[aria-label="整理 个人盘 /资料/b/计划.pdf"]').setValue(true)
  await button(view, '生成整理清单').trigger('click'); await flushPromises()
  expect(api.createPlan).toHaveBeenCalledExactlyOnceWith({ group: { name: '计划.pdf', size: 100 }, keep: { accountId: 'a', fileId: 'same' }, remove: [{ accountId: 'b', fileId: 'same' }] })
  expect(view.get('[aria-label="整理清单预览"]').text()).toContain('已确认重复预计释放 0 B · 候选估算 100 B')
  await button(view, '导出 CSV 清单').trigger('click'); await flushPromises()
  expect(api.exportPlan).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', keep: { accountId: 'a', fileId: 'same' } }))
  expect(view.text()).toContain('整理清单已导出')
  await view.get('input[aria-label="保留 个人盘 /资料/b/计划.pdf"]').setValue(true)
  expect(view.find('[aria-label="整理清单预览"]').exists()).toBe(false)
  expect(view.get('input[aria-label="整理 个人盘 /资料/b/计划.pdf"]').attributes('disabled')).toBeDefined()
})

it('reads evidence only for the explicit current page and keeps missing hash results as candidates', async () => {
  const view = await render()
  await button(view, '重复文件候选').trigger('click'); await flushPromises(); await button(view, '查看副本').trigger('click'); await flushPromises()
  await button(view, '核验本页哈希').trigger('click'); await flushPromises()
  expect(api.verifyEvidence).toHaveBeenCalledExactlyOnceWith({ refs: [{ accountId: 'a', fileId: 'same' }, { accountId: 'b', fileId: 'same' }] })
  expect(view.text()).toContain('仍只作为候选'); expect(view.text()).toContain('本次已取得 0 份哈希证据')
  await view.get('select[aria-label="证据状态"]').setValue('confirmed'); await flushPromises()
  expect(api.listDuplicateGroups).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed', page: 1 }))
  expect(view.find('[aria-label="重复候选副本"]').exists()).toBe(false)
})

it('ignores late member and plan responses after closing or changing the selected group', async () => {
  const view = await render(), oldMembers = deferred<unknown>()
  await button(view, '重复文件候选').trigger('click'); await flushPromises()
  api.listGroupMembers.mockReturnValueOnce(oldMembers.promise)
  await button(view, '查看副本').trigger('click'); await button(view, '关闭副本').trigger('click')
  oldMembers.resolve({ success: true, items: [member()], total: 1, page: 1, pageSize: 25 }); await flushPromises()
  expect(view.find('[aria-label="重复候选副本"]').exists()).toBe(false)
  await button(view, '查看副本').trigger('click'); await flushPromises()
  await view.get('input[type="radio"]').setValue(true); await view.findAll('input[type="checkbox"]')[1].setValue(true)
  const oldPlan = deferred<unknown>(); api.createPlan.mockReturnValueOnce(oldPlan.promise)
  await button(view, '生成整理清单').trigger('click'); await button(view, '清空选择').trigger('click')
  oldPlan.resolve({ success: true, plan }); await flushPromises()
  expect(view.find('[aria-label="整理清单预览"]').exists()).toBe(false)
})

it('locates files through CatalogService and displays actionable failures and empty states', async () => {
  const view = await render()
  await button(view, '核对并定位').trigger('click'); await flushPromises()
  expect(catalog.resolveEntry).toHaveBeenCalledWith({ accountId: 'a', fileId: 'dir' })
  expect(router.push).toHaveBeenCalledWith({ path: '/files', query: { accountId: 'a', fileId: 'same', parentId: 'root', path: '/资料/a/计划.pdf', from: 'catalog' } })
  catalog.resolveEntry.mockResolvedValueOnce({ success: false, error: '远端文件已变化，请重新扫描' })
  await button(view, '核对并定位').trigger('click'); await flushPromises()
  expect(view.text()).toContain('无法确认来源：远端文件已变化')
  api.listDirectories.mockResolvedValueOnce({ success: false, error: '本地查询失败' })
  await button(view, '刷新分析').trigger('click'); await flushPromises()
  expect(view.text()).toContain('本地查询失败')
  api.listDirectories.mockResolvedValueOnce({ success: true, items: [], total: 0, page: 1, pageSize: 25 })
  await button(view, '重读结果').trigger('click'); await flushPromises()
  expect(view.text()).toContain('没有匹配的索引内容')
})
