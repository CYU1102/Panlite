// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ shareList: vi.fn().mockResolvedValue({ success: true, links: [] }), error: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: api.error } }))
import ShareLinks from './ShareLinks.vue'
const views: ReturnType<typeof shallowMount>[] = []
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.restoreAllMocks(); vi.clearAllMocks() })
const row = { id: 'share', share_url: 'https://pan.quark.cn/s/abc?pwd=a1B2', title: '项目资料', password: 'a1B2' }
function render() { const view = shallowMount(ShareLinks, { attachTo: document.body }); views.push(view); return view }

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
