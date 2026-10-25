// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ shareList: vi.fn(), shareDelete: vi.fn(), shareCancel: vi.fn(), confirm: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: api.error, success: api.success } }))
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({ ElMessageBox: { confirm: api.confirm } }))
import ShareLinks from './ShareLinks.vue'
const views: ReturnType<typeof shallowMount>[] = []
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.restoreAllMocks(); vi.clearAllMocks() })
beforeEach(() => {
  vi.resetAllMocks()
  api.shareList.mockResolvedValue({ success: true, links: [] })
  api.shareDelete.mockResolvedValue({ success: true })
  api.shareCancel.mockResolvedValue({ success: true })
  api.confirm.mockResolvedValue('confirm')
})
const row = { id: 'share', share_url: 'https://pan.quark.cn/s/abc?pwd=a1B2', title: '项目资料', password: 'a1B2', status: 'active', updated_at: 0 }
function render() { const view = shallowMount(ShareLinks, { attachTo: document.body }); views.push(view); return view }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
interface ShareModel {
  links: typeof row[]
  selectedRows: typeof row[]
  filters: { platform: string; status: string; keyword: string }
  loading: boolean
  busyRowIds: Set<string>
  loadData(): Promise<void>
  onDelete(input: typeof row): Promise<void>
  onCancel(input: typeof row): Promise<void>
  onSelectionChange(rows: typeof row[]): void
}
function model(view: ReturnType<typeof render>) { return view.vm as unknown as ShareModel }

it('opens inside the current page and returns without losing filters or selection', async () => {
  const external = vi.spyOn(window, 'open')
  const view = render(); await flushPromises()
  const vm = view.vm as unknown as { onOpen: (row: unknown) => void; filters: { keyword: string }; selectedRows: unknown[] }
  vm.filters.keyword = '项目'; vm.selectedRows = [row]
  vm.onOpen(row); await flushPromises()
  const browser = view.findComponent({ name: 'ShareLinkBrowser' })
  expect(browser.props()).toMatchObject({ url: row.share_url, title: row.title, password: row.password })
  expect(view.get('.table-card').isVisible()).toBe(false)
  expect(external).not.toHaveBeenCalled()
  browser.vm.$emit('close'); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  expect(view.get('.table-card').isVisible()).toBe(true)
  expect(vm.filters.keyword).toBe('项目')
  expect(vm.selectedRows).toEqual([row])
})

it('rejects invalid link protocols instead of launching any window', async () => {
  const external = vi.spyOn(window, 'open'), view = render()
  const vm = view.vm as unknown as { onOpen: (row: unknown) => void }
  vm.onOpen({ ...row, share_url: 'javascript:alert(1)' }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  expect(api.error).toHaveBeenCalledWith('分享链接无效，仅支持 HTTP(S) 链接')
  expect(external).not.toHaveBeenCalled()
})

it('keeps the latest filter response when an older request arrives later', async () => {
  const view = render(); await flushPromises(); const vm = model(view)
  const earlier = deferred<unknown>(), latest = deferred<unknown>()
  api.shareList.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise)
  vm.filters.platform = 'quark'; const oldRequest = vm.loadData()
  vm.filters.platform = 'baidu'; const newRequest = vm.loadData()
  latest.resolve({ success: true, links: [{ ...row, id: 'latest' }] }); await newRequest
  earlier.resolve({ success: true, links: [{ ...row, id: 'old' }] }); await oldRequest
  expect(vm.links.map(item => item.id)).toEqual(['latest'])
  expect(vm.loading).toBe(false)
})

it('ignores an older request failure without releasing the latest loading state', async () => {
  const view = render(); await flushPromises(); const vm = model(view)
  const earlier = deferred<unknown>(), latest = deferred<unknown>()
  api.shareList.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise)
  const oldRequest = vm.loadData(), newRequest = vm.loadData()
  earlier.reject(new Error('obsolete failure')); await oldRequest
  expect(vm.loading).toBe(true); expect(api.error).not.toHaveBeenCalled()
  latest.resolve({ success: true, links: [row] }); await newRequest
  expect(vm.links).toEqual([row]); expect(vm.loading).toBe(false)
})

it('reports list transport errors while retaining the last confirmed rows', async () => {
  api.shareList.mockResolvedValueOnce({ success: true, links: [row] })
  const view = render(); await flushPromises(); const vm = model(view)
  api.shareList.mockRejectedValueOnce(new Error('IPC disconnected'))
  await vm.loadData()
  expect(vm.links).toEqual([row]); expect(vm.loading).toBe(false)
  expect(api.error).toHaveBeenCalledWith(expect.stringContaining('IPC disconnected'))
})

it('does not resurrect a deleted record from an in-flight refresh', async () => {
  api.shareList.mockResolvedValueOnce({ success: true, links: [row] })
  const view = render(); await flushPromises(); const vm = model(view)
  vm.selectedRows = [row]
  const earlier = deferred<unknown>(); api.shareList.mockReturnValueOnce(earlier.promise)
  const pendingRead = vm.loadData()
  await vm.onDelete(row)
  expect(vm.links).toEqual([]); expect(vm.selectedRows).toEqual([])
  earlier.resolve({ success: true, links: [row] }); await pendingRead
  expect(vm.links).toEqual([])
  vm.onSelectionChange([row])
  expect(vm.selectedRows).toEqual([])
})

it('keeps a successful cancellation consistent with the active filter and a late list read', async () => {
  api.shareList.mockResolvedValueOnce({ success: true, links: [{ ...row }] })
  const view = render(); await flushPromises(); const vm = model(view)
  vm.filters.status = 'active'; vm.selectedRows = [...vm.links]
  const earlier = deferred<unknown>(); api.shareList.mockReturnValueOnce(earlier.promise)
  const pendingRead = vm.loadData()
  await vm.onCancel(vm.links[0])
  expect(vm.links).toEqual([]); expect(vm.selectedRows).toEqual([])
  earlier.resolve({ success: true, links: [{ ...row, status: 'active' }] }); await pendingRead
  expect(vm.links).toEqual([])
})

it.each(['onDelete', 'onCancel'] as const)('catches rejected IPC in %s and leaves the row retryable', async method => {
  api.shareList.mockResolvedValueOnce({ success: true, links: [{ ...row }] })
  const view = render(); await flushPromises(); const vm = model(view)
  api[method === 'onDelete' ? 'shareDelete' : 'shareCancel'].mockRejectedValueOnce(new Error('transport failed'))
  await vm[method](vm.links[0])
  expect(vm.links[0].status).toBe('active'); expect(vm.busyRowIds.size).toBe(0)
  expect(api.error).toHaveBeenCalledWith(expect.stringContaining('transport failed'))
  await vm[method](vm.links[0])
  expect(api.success).toHaveBeenCalled()
})

it('prevents duplicate cancellation while its confirmation is pending', async () => {
  const view = render(); await flushPromises(); const vm = model(view)
  const confirmation = deferred<unknown>(); api.confirm.mockReturnValueOnce(confirmation.promise)
  const first = vm.onCancel({ ...row }), second = vm.onCancel({ ...row })
  await second
  expect(api.confirm).toHaveBeenCalledTimes(1)
  confirmation.resolve('confirm'); await first
  expect(api.shareCancel).toHaveBeenCalledTimes(1)
})

it('does not submit a mutation after the page is unmounted during confirmation', async () => {
  const view = render(); await flushPromises(); const vm = model(view)
  const confirmation = deferred<unknown>(); api.confirm.mockReturnValueOnce(confirmation.promise)
  const pending = vm.onDelete(row)
  view.unmount(); views.splice(views.indexOf(view), 1)
  confirmation.resolve('confirm'); await pending
  expect(api.shareDelete).not.toHaveBeenCalled()
})
