// @vitest-environment jsdom
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ShareSubscriptionsPanel from './ShareSubscriptionsPanel.vue'
import type { ShareSubscription } from '@shared/subscription-types'

const api = vi.hoisted(() => ({ subscriptionList: vi.fn(), subscriptionAdd: vi.fn(), subscriptionToggle: vi.fn(), subscriptionRunNow: vi.fn(), subscriptionRemove: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: api }))
let wrapper: VueWrapper
type ViewModel = { draft: { scope: string; initialMode: string; extensions: string; include: string; exclude: string; title: string }; recursiveSupported: boolean; save(): Promise<void>; edit(item: ShareSubscription): void; toggle(item: ShareSubscription): Promise<void> }
const model = () => wrapper.vm as unknown as ViewModel
function render(platform = 'quark') {
  wrapper = shallowMount(ShareSubscriptionsPanel, { props: { accountId: 'account', platform, links: [{ url: 'https://pan.quark.cn/s/share', password: 'code' }], targetDirId: 'target', targetDirPath: '/Library/Series' },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  return wrapper
}
beforeEach(() => { vi.clearAllMocks(); api.subscriptionList.mockResolvedValue({ success: true, subscriptions: [] }); api.subscriptionAdd.mockResolvedValue({ success: true, id: 'new' }) })
afterEach(() => wrapper?.unmount())

describe('subscription configuration UI', () => {
  it('defaults to a non-transferring first baseline and sends the full selected target path', async () => {
    render(); await flushPromises(); await model().save()
    expect(api.subscriptionAdd).toHaveBeenCalledWith(expect.objectContaining({ initialMode: 'baseline', scope: 'root', targetDirPath: '/Library/Series', password: 'code' }))
  })
  it('sends explicit recursive and filter preferences to the main process', async () => {
    render(); await flushPromises()
    Object.assign(model().draft, { scope: 'recursive', initialMode: 'save_existing', extensions: 'mkv， mp4', include: 'Season', exclude: 'advert' })
    await model().save()
    expect(api.subscriptionAdd).toHaveBeenCalledWith(expect.objectContaining({ scope: 'recursive', initialMode: 'save_existing', extensions: ['mkv', 'mp4'], includeKeywords: ['Season'], excludeKeywords: ['advert'] }))
  })
  it('disables recursive capability for unsupported platforms and explains the boundary', async () => {
    render('baidu'); await flushPromises()
    expect(model().recursiveSupported).toBe(false)
    expect(wrapper.text()).toContain('已有文件夹内的变化无法检测')
  })
  it('keeps the edited account and destination, and sends the expected configuration version', async () => {
    render(); await flushPromises()
    model().edit({ id: 'existing', configVersion: 7, accountId: 'old-account', platform: 'quark', url: 'https://pan.quark.cn/s/old', targetDirId: 'old-target', targetDirPath: '/Old', title: 'Old', scope: 'root' } as ShareSubscription)
    await model().save()
    expect(api.subscriptionAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing', expectedVersion: 7, accountId: 'old-account', targetDirId: 'old-target', targetDirPath: '/Old' }))
  })
  it('pauses only the chosen subscription through the existing IPC contract', async () => {
    render(); await flushPromises(); api.subscriptionToggle.mockResolvedValue({ success: true })
    await model().toggle({ id: 'sub', status: 'active' } as ShareSubscription)
    expect(api.subscriptionToggle).toHaveBeenCalledWith({ id: 'sub', active: false })
  })
})
