// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ResourceSearch from './ResourceSearch.vue'

const api = vi.hoisted(() => ({ searchSourcesList: vi.fn(), openExternal: vi.fn(), onResourceShareOpen: vi.fn(), cleanupShareOpen: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, error: api.error } }))
const views: ReturnType<typeof shallowMount>[] = []
const site = { id: 'site', name: 'fixture', url: 'https://source.example.test/', platform: 'quark', capabilities: '[]' }
const link = { title: '资料', url: 'https://pan.quark.cn/s/fixture', password: 'Ab12' }
interface ResourceModel {
  sites: typeof site[]
  activeSite: typeof site | null
  currentUrl: string
  showExtractedLinks: boolean
  extractedLinks: typeof link[]
  openShareLink(input: typeof link): void
  selectSite(input: typeof site): void
  openExternalSite(url: string): Promise<void>
}
function render() {
  const view = shallowMount(ResourceSearch, { attachTo: document.body, global: { plugins: [createPinia()], stubs: { TransferDialog: true, webview: true } } })
  views.push(view)
  return { view, vm: view.vm as unknown as ResourceModel }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.searchSourcesList.mockResolvedValue({ success: true, sources: [site] })
  api.openExternal.mockResolvedValue({ success: true })
  api.onResourceShareOpen.mockReturnValue(api.cleanupShareOpen)
})
afterEach(() => { views.splice(0).forEach(view => view.unmount()); vi.unstubAllGlobals() })

it('opens an extracted share inline and returns to the existing source page and results', async () => {
  const { view, vm } = render(); await flushPromises()
  vm.selectSite(vm.sites[0]); await flushPromises()
  const sourceGuest = view.get('.webview').element
  vm.currentUrl = 'https://source.example.test/search?q=fixture'
  vm.extractedLinks = [link]; vm.showExtractedLinks = true
  vm.openShareLink(link); await flushPromises()
  const browser = view.findComponent({ name: 'ShareLinkBrowser' })
  expect(browser.props()).toMatchObject({ url: link.url, title: link.title, password: link.password })
  expect(view.get('.resource-page').isVisible()).toBe(false)
  expect(vm.showExtractedLinks).toBe(false)
  expect(api.openExternal).not.toHaveBeenCalled()
  browser.vm.$emit('close'); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  expect(view.get('.resource-page').isVisible()).toBe(true)
  expect(view.get('.webview').element).toBe(sourceGuest)
  expect(vm.currentUrl).toBe('https://source.example.test/search?q=fixture')
  expect(vm.showExtractedLinks).toBe(true)
  expect(vm.extractedLinks).toEqual([link])
})

it('rejects non-HTTP share links without launching a browser', async () => {
  const { view, vm } = render(); await flushPromises()
  vm.openShareLink({ ...link, url: 'javascript:alert(1)' }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  expect(api.openExternal).not.toHaveBeenCalled()
  expect(api.error).toHaveBeenCalledWith('分享链接无效，仅支持 HTTP(S) 链接')
})

it('copies the opened share and extraction code and handles a rejected clipboard write', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const { view, vm } = render(); await flushPromises()
  vm.openShareLink(link); await flushPromises()
  const browser = view.findComponent({ name: 'ShareLinkBrowser' })
  browser.vm.$emit('copy'); await flushPromises()
  expect(writeText).toHaveBeenCalledWith(`${link.url} 提取码: ${link.password}`)
  expect(api.success).toHaveBeenCalledWith('已复制链接')
  writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
  browser.vm.$emit('copy'); await flushPromises()
  expect(api.error).toHaveBeenCalledWith('复制失败')
})

it('opens the system browser only for the explicit site fallback and reports failures', async () => {
  const { vm } = render(); await flushPromises()
  await vm.openExternalSite(site.url)
  expect(api.openExternal).toHaveBeenCalledWith(site.url)
  api.openExternal.mockRejectedValueOnce(new Error('OS refused'))
  await vm.openExternalSite(site.url)
  expect(api.error).toHaveBeenCalledWith(expect.stringContaining('OS refused'))
})

it('opens only a verified current resource guest share and returns without an empty extraction dialog', async () => {
  const { view, vm } = render(); await flushPromises()
  vm.selectSite(vm.sites[0]); await flushPromises()
  Object.assign(view.get('.webview').element, { getWebContentsId: () => 72 })
  const receive = api.onResourceShareOpen.mock.calls[0][0]
  receive({ guestId: 71, url: link.url }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  receive({ guestId: 72, url: 'https://evil.test/?next=' + link.url }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  receive({ guestId: 72, url: link.url + '?pwd=Ab12' }); await flushPromises()
  const browser = view.getComponent({ name: 'ShareLinkBrowser' })
  expect(browser.props()).toMatchObject({ url: link.url + '?pwd=Ab12', password: 'Ab12' })
  expect(api.openExternal).not.toHaveBeenCalled()
  browser.vm.$emit('close'); await flushPromises()
  expect(vm.showExtractedLinks).toBe(false)
  view.unmount(); expect(api.cleanupShareOpen).toHaveBeenCalledOnce()
})

it('recreates the resource session on source changes and rejects a stale guest handoff', async () => {
  const { view, vm } = render(); await flushPromises()
  vm.selectSite(vm.sites[0]); await flushPromises()
  const previous = view.get('.webview').element, partition = view.get('.webview').attributes('partition')
  Object.assign(previous, { getWebContentsId: () => 1 })
  vm.selectSite({ ...vm.sites[0], id: 'other', url: 'https://other.example.test/' }); await flushPromises()
  Object.assign(view.get('.webview').element, { getWebContentsId: () => 2 })
  expect(view.get('.webview').element).not.toBe(previous)
  expect(view.get('.webview').attributes('partition')).not.toBe(partition)
  expect(view.get('.webview').attributes()).toHaveProperty('allowpopups')
  api.onResourceShareOpen.mock.calls[0][0]({ guestId: 1, url: link.url }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
})

it('retains an early popup until guest readiness and ignores notifications after unmount', async () => {
  const { view, vm } = render(); await flushPromises()
  vm.selectSite(vm.sites[0]); await flushPromises()
  const guest = view.get('.webview')
  Object.assign(guest.element, { getWebContentsId: () => { throw new Error('Not ready') } })
  const receive = api.onResourceShareOpen.mock.calls[0][0]
  receive({ guestId: 9, url: link.url }); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(false)
  Object.assign(guest.element, { getWebContentsId: () => 9 })
  await guest.trigger('dom-ready'); await flushPromises()
  expect(view.findComponent({ name: 'ShareLinkBrowser' }).exists()).toBe(true)
  view.unmount()
  expect(() => receive({ guestId: 9, url: link.url })).not.toThrow()
  expect(api.cleanupShareOpen).toHaveBeenCalledOnce()
})
