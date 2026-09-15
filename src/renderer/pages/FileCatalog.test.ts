// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CatalogEntry, CatalogQuery, CatalogScope } from '@shared/catalog'

const api = vi.hoisted(() => ({ listScopes: vi.fn(), addScope: vi.fn(), removeScope: vi.fn(), startScan: vi.fn(), pauseScan: vi.fn(), resumeScan: vi.fn(), search: vi.fn(), listTags: vi.fn(), setTags: vi.fn(), setFavorite: vi.fn(), listCollections: vi.fn(), saveCollection: vi.fn(), removeCollection: vi.fn(), setEntryCollections: vi.fn(), resolveEntry: vi.fn() }))
const electron = vi.hoisted(() => ({ listAccounts: vi.fn(), listFiles: vi.fn() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('../api/catalog', () => ({ catalogApi: api }))
vi.mock('../api/ipc', () => ({ electronApi: electron }))
vi.mock('vue-router', () => ({ useRouter: () => navigation }))
import FileCatalog from './FileCatalog.vue'

const now = Date.now()
const accounts = [
  { id: 'account-a', nickname: '工作盘', platform: 'quark', status: 'active' },
  { id: 'account-b', nickname: '个人盘', platform: 'webdav', status: 'active' },
]
function entry(accountId = 'account-a', name = '项目报告.pdf'): CatalogEntry {
  return { accountId, fileId: 'same-provider-id', name, parentId: 'parent-1', path: `/项目/${name}`, isDir: false, size: 2048, createdAt: now, updatedAt: now, indexedAt: now, fileType: 'document', platform: 'quark', accountNickname: accountId === 'account-a' ? '工作盘' : '个人盘', accountStatus: 'active', tags: ['项目'], favorite: false, collectionIds: [] }
}
function scope(id: string, status: CatalogScope['status']): CatalogScope {
  return { id, accountId: 'account-a', accountNickname: '工作盘', platform: 'quark', rootId: id, rootPath: `/${id}`, status, scannedDirectories: 3, pendingDirectories: 2, failedDirectories: 0, entryCount: 12, failures: [], createdAt: now, updatedAt: now, lastScanAt: now, lastCompletedAt: status === 'completed' ? now : null, accountStatus: 'active' }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let wrapper: VueWrapper | undefined
const rowA = entry()
const rowB = entry('account-b', '个人笔记.pdf')

beforeEach(() => {
  vi.resetAllMocks()
  electron.listAccounts.mockResolvedValue({ success: true, accounts })
  electron.listFiles.mockResolvedValue({ success: true, files: [], hasMore: false, parentId: '0' })
  api.listScopes.mockResolvedValue({ success: true, scopes: [scope('running', 'running'), scope('paused', 'paused'), scope('completed', 'completed')] })
  api.search.mockImplementation((query: CatalogQuery) => Promise.resolve({ success: true, entries: [rowA, rowB], total: 2, page: query.page || 1, pageSize: query.pageSize || 50 }))
  api.listTags.mockResolvedValue({ success: true, tags: ['项目'] })
  api.listCollections.mockResolvedValue({ success: true, collections: [{ id: 'collection-1', name: '参考资料', entryCount: 0, createdAt: now, updatedAt: now }] })
  for (const key of ['addScope', 'removeScope', 'startScan', 'pauseScan', 'resumeScan', 'setTags', 'setFavorite', 'saveCollection', 'removeCollection', 'setEntryCollections'] as const) api[key].mockResolvedValue({ success: true })
  api.resolveEntry.mockResolvedValue({ success: true, entry: rowA })
  navigation.push.mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function render() { wrapper = mount(FileCatalog); await flushPromises(); return wrapper }
function button(view: VueWrapper, text: string) { const match = view.findAll('button').find(control => control.text() === text); if (!match) throw new Error(`Button not found: ${text}`); return match }

it('builds bounded IPC queries from visible filters and reads one page at a time', async () => {
  api.search.mockImplementation((query: CatalogQuery) => Promise.resolve({ success: true, entries: query.page === 2 ? [rowB] : [rowA], total: 73, page: query.page || 1, pageSize: query.pageSize || 50 }))
  const view = await render()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }))
  expect(view.findAll('tbody tr')).toHaveLength(1)
  await button(view, '下一页').trigger('click'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 50 }))
  expect(view.get('tbody').text()).toContain('个人笔记.pdf')
  await button(view, '筛选').trigger('click')
  await view.get('input[aria-label="文件名称"]').setValue('报告')
  await view.get('input[aria-label="路径包含"]').setValue('/项目')
  await view.get('select[aria-label="来源账号"]').setValue('account-a')
  await view.get('select[aria-label="文件类型"]').setValue('document')
  await view.get('input[aria-label="标签包含"]').setValue('项目，待整理')
  await view.get('input[aria-label="最小大小"]').setValue('1')
  await view.get('input[aria-label="最大大小"]').setValue('3')
  await view.get('form.search-panel').trigger('submit'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, keyword: '报告', path: '/项目', accountIds: ['account-a'], fileTypes: ['document'], tags: ['项目', '待整理'], minSize: 1048576, maxSize: 3145728 }))
  await view.get('select[aria-label="每页条数"]').setValue(25); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 25 }))
})

it('does not let a late query replace newer search results', async () => {
  const view = await render()
  const oldSearch = deferred<unknown>()
  api.search.mockReturnValueOnce(oldSearch.promise)
  await view.get('input[aria-label="文件名称"]').setValue('旧')
  await view.get('form.search-panel').trigger('submit')
  api.search.mockResolvedValueOnce({ success: true, entries: [rowB], total: 1, page: 1, pageSize: 50 })
  await view.get('input[aria-label="文件名称"]').setValue('个人')
  await view.get('form.search-panel').trigger('submit'); await flushPromises()
  oldSearch.resolve({ success: true, entries: [rowA], total: 1, page: 1, pageSize: 50 }); await flushPromises()
  expect(view.get('tbody').text()).toContain('个人笔记.pdf')
  expect(view.get('tbody').text()).not.toContain('项目报告.pdf')
})

it('shows scan failures and sends pause, resume, and rescan only to their selected scope', async () => {
  const view = await render()
  await button(view, '暂停').trigger('click'); await flushPromises()
  expect(api.pauseScan).toHaveBeenCalledExactlyOnceWith('running')
  await button(view, '恢复').trigger('click'); await flushPromises()
  expect(api.resumeScan).toHaveBeenCalledExactlyOnceWith('paused')
  api.startScan.mockResolvedValueOnce({ success: false, error: '账号已过期，请重新登录' })
  const completed = view.findAll('.scope-row').find(row => row.attributes('data-scope-id') === 'completed')!
  await completed.findAll('button').find(control => control.text() === '重新扫描')!.trigger('click'); await flushPromises()
  expect(api.startScan).toHaveBeenCalledExactlyOnceWith('completed')
  expect(view.text()).toContain('账号已过期，请重新登录')
  expect(view.text()).toContain('上次完整完成')
})

it('keeps the chosen real directory after saving its scope fails and ignores stale account reads', async () => {
  const view = await render()
  await button(view, '添加目录').trigger('click')
  const lateAccount = deferred<unknown>()
  electron.listFiles.mockReturnValueOnce(lateAccount.promise)
  await view.get('select[aria-label="扫描账号"]').setValue('account-a')
  electron.listFiles.mockResolvedValueOnce({ success: true, parentId: '0', hasMore: false, files: [{ id: 'dir-b', name: '个人资料', path: '/个人资料', isDir: true }] })
  await view.get('select[aria-label="扫描账号"]').setValue('account-b'); await flushPromises()
  lateAccount.resolve({ success: true, parentId: '0', hasMore: false, files: [{ id: 'dir-a', name: '旧账号目录', isDir: true }] }); await flushPromises()
  expect(view.find('.directory-list').text()).toContain('个人资料')
  expect(view.find('.directory-list').text()).not.toContain('旧账号目录')
  await view.get('button.folder').trigger('click'); await flushPromises()
  expect(electron.listFiles).toHaveBeenLastCalledWith('account-b', 'dir-b', false)
  api.addScope.mockResolvedValueOnce({ success: false, error: '无法写入本地数据库' })
  await button(view, '添加当前目录').trigger('click'); await flushPromises()
  expect(api.addScope).toHaveBeenCalledWith({ accountId: 'account-b', rootId: 'dir-b', rootPath: '/个人资料' })
  expect(view.text()).toContain('无法写入本地数据库')
  expect(view.find('.scope-picker').exists()).toBe(true)
  expect(view.get('select[aria-label="扫描账号"]').element).toHaveProperty('value', 'account-b')
  await button(view, '添加当前目录').trigger('click'); await flushPromises()
  expect(view.find('.scope-picker').exists()).toBe(false)
})

it('retains tag drafts on save failure and uses account plus file identity for local edits', async () => {
  const view = await render()
  await view.findAll('.file-name')[1].trigger('click')
  await view.get('input[aria-label="本地标签"]').setValue('个人，待整理')
  api.setTags.mockResolvedValueOnce({ success: false, error: '磁盘空间不足' })
  await view.findAll('.editor-forms form')[0].trigger('submit'); await flushPromises()
  expect(api.setTags).toHaveBeenCalledWith({ accountId: 'account-b', fileId: 'same-provider-id', tags: ['个人', '待整理'] })
  expect(view.text()).toContain('标签未保存：磁盘空间不足')
  expect(view.get('input[aria-label="本地标签"]').element).toHaveProperty('value', '个人，待整理')
  expect(view.findAll('tbody .tag').map(tag => tag.text())).toEqual(['项目', '项目'])
  await view.findAll('.editor-forms form')[0].trigger('submit'); await flushPromises()
  expect(view.text()).toContain('标签已保存到本地')
  await view.get('input[aria-label="加入参考资料"]').setValue(true)
  await view.findAll('.editor-forms form')[1].trigger('submit'); await flushPromises()
  expect(api.setEntryCollections).toHaveBeenCalledWith({ accountId: 'account-b', fileId: 'same-provider-id', collectionIds: ['collection-1'] })
})

it('does not leak a prior file save failure into a newly selected file editor', async () => {
  const view = await render()
  const saving = deferred<unknown>()
  api.setTags.mockReturnValueOnce(saving.promise)
  await view.findAll('.file-name')[0].trigger('click')
  await view.get('input[aria-label="本地标签"]').setValue('旧文件标签')
  await view.findAll('.editor-forms form')[0].trigger('submit')
  expect(api.setTags).toHaveBeenCalledWith({ accountId: 'account-a', fileId: 'same-provider-id', tags: ['旧文件标签'] })
  await view.findAll('.file-name')[1].trigger('click')
  saving.resolve({ success: false, error: '旧请求失败' }); await flushPromises()
  expect(view.get('.editor-title').text()).toContain('个人笔记.pdf')
  expect(view.text()).not.toContain('旧请求失败')
  expect(view.get('input[aria-label="本地标签"]').element).toHaveProperty('value', '项目')
  expect(button(view, '保存标签').attributes('disabled')).toBeUndefined()
})

it('keeps favorites unchanged on rejection and applies favorite and collection search filters', async () => {
  const view = await render()
  api.setFavorite.mockResolvedValueOnce({ success: false, error: '数据库只读' })
  await view.get('button[aria-label="收藏个人笔记.pdf"]').trigger('click'); await flushPromises()
  expect(api.setFavorite).toHaveBeenCalledWith({ accountId: 'account-b', fileId: 'same-provider-id', favorite: true })
  expect(view.get('button[aria-label="收藏个人笔记.pdf"]').attributes('aria-pressed')).toBe('false')
  expect(view.text()).toContain('收藏未保存，数据库只读')
  await button(view, '我的收藏').trigger('click'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: true, page: 1 }))
  await view.findAll('.collection-chip').find(control => control.text().startsWith('参考资料'))!.trigger('click'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ collectionId: 'collection-1', favorite: undefined, page: 1 }))
})

it('preserves collection creation drafts on failure and removes only the confirmed virtual collection', async () => {
  const view = await render()
  await button(view, '管理集合').trigger('click')
  await view.get('input[aria-label="集合名称"]').setValue('旅行资料')
  api.saveCollection.mockResolvedValueOnce({ success: false, error: '集合名称已存在' })
  await view.get('form.collection-create').trigger('submit'); await flushPromises()
  expect(view.get('input[aria-label="集合名称"]').element).toHaveProperty('value', '旅行资料')
  expect(view.text()).toContain('集合名称已存在')
  await button(view, '删除集合').trigger('click')
  expect(api.removeCollection).not.toHaveBeenCalled()
  await button(view, '确认删除集合').trigger('click'); await flushPromises()
  expect(api.removeCollection).toHaveBeenCalledExactlyOnceWith('collection-1')
})

it('confirms the remote identity before navigating and stays local when verification fails', async () => {
  const view = await render()
  api.resolveEntry.mockResolvedValueOnce({ success: false, error: '远端文件已移动或删除' })
  await view.findAll('.locate-cell button')[0].trigger('click'); await flushPromises()
  expect(navigation.push).not.toHaveBeenCalled()
  expect(view.text()).toContain('远端文件已移动或删除')
  await view.findAll('.locate-cell button')[0].trigger('click'); await flushPromises()
  expect(api.resolveEntry).toHaveBeenCalledWith({ accountId: 'account-a', fileId: 'same-provider-id' })
  expect(navigation.push).toHaveBeenCalledWith({ path: '/files', query: { accountId: 'account-a', parentId: 'parent-1', fileId: 'same-provider-id', path: '/项目/项目报告.pdf', from: 'catalog' } })
})

it('continues showing local results when accounts or scan status cannot be read', async () => {
  electron.listAccounts.mockRejectedValueOnce(new Error('账号列表读取失败'))
  api.listScopes.mockResolvedValueOnce({ success: false, error: '扫描状态暂不可用' })
  const view = await render()
  expect(view.text()).toContain('账号列表读取失败')
  expect(view.text()).toContain('扫描状态暂不可用')
  expect(view.findAll('tbody tr')).toHaveLength(2)
  expect(view.text()).toContain('连接未验证')
})

it('rejects inverted filters without querying and distinguishes query errors from empty results', async () => {
  const view = await render()
  await button(view, '筛选').trigger('click')
  await view.get('input[aria-label="最小大小"]').setValue('10')
  await view.get('input[aria-label="最大大小"]').setValue('1')
  const count = api.search.mock.calls.length
  await view.get('form.search-panel').trigger('submit')
  expect(api.search).toHaveBeenCalledTimes(count)
  expect(view.text()).toContain('最小值不能大于最大值')
  api.search.mockRejectedValueOnce(new Error('索引数据库不可用'))
  await button(view, '刷新结果').trigger('click'); await flushPromises()
  expect(view.text()).toContain('本地目录查询失败')
  expect(view.text()).toContain('索引数据库不可用')
  expect(view.text()).not.toContain('没有匹配的索引文件')
})

it('converts fractional MB bounds to integer byte limits accepted by the catalog service', async () => {
  const view = await render()
  await button(view, '筛选').trigger('click')
  await view.get('input[aria-label="最小大小"]').setValue('0.1')
  await view.get('input[aria-label="最大大小"]').setValue('0.3')
  await view.get('form.search-panel').trigger('submit'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ minSize: 104858, maxSize: 314572 }))
})

it('keeps a scope and its removal confirmation visible when deletion fails', async () => {
  const view = await render()
  const completed = view.findAll('.scope-row').find(row => row.attributes('data-scope-id') === 'completed')!
  await completed.findAll('button').find(control => control.text() === '移除范围')!.trigger('click')
  expect(api.removeScope).not.toHaveBeenCalled()
  api.removeScope.mockResolvedValueOnce({ success: false, error: '数据库繁忙' })
  await button(view, '确认移除范围').trigger('click'); await flushPromises()
  expect(api.removeScope).toHaveBeenCalledExactlyOnceWith('completed')
  expect(view.text()).toContain('数据库繁忙')
  expect(view.findAll('.scope-row')).toHaveLength(3)
  expect(button(view, '确认移除范围').exists()).toBe(true)
})

it('returns to the last valid page when a refreshed index has fewer entries', async () => {
  api.search.mockImplementation((query: CatalogQuery) => Promise.resolve({ success: true, entries: [rowA], total: 80, page: query.page || 1, pageSize: 50 }))
  const view = await render()
  await button(view, '下一页').trigger('click'); await flushPromises()
  api.search.mockImplementation((query: CatalogQuery) => Promise.resolve({ success: true, entries: query.page === 1 ? [rowA] : [], total: 1, page: query.page || 1, pageSize: 50 }))
  await button(view, '刷新结果').trigger('click'); await flushPromises()
  expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }))
  expect(view.findAll('tbody tr')).toHaveLength(1)
  expect(view.text()).toContain('第 1 / 1 页')
})

it('prevents saving incomplete collection membership when collection metadata is unavailable', async () => {
  api.listCollections.mockRejectedValueOnce(new Error('集合暂不可用'))
  const view = await render()
  await view.findAll('.file-name')[0].trigger('click')
  expect(view.text()).toContain('集合暂不可用')
  expect(button(view, '保存集合归属').attributes('disabled')).toBeDefined()
  expect(api.setEntryCollections).not.toHaveBeenCalled()
})
