// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import ShareLinkBrowser from './ShareLinkBrowser.vue'
import { SHARE_BROWSER_PARTITION } from '@shared/share-browser'

const views: ReturnType<typeof mount>[] = []
afterEach(() => views.splice(0).forEach(view => view.unmount()))
function render() {
  const view = mount(ShareLinkBrowser, { props: { url: 'https://pan.quark.cn/s/abc?pwd=a1B2', title: '项目资料', password: 'a1B2' } })
  views.push(view)
  return view
}

it('renders an in-page guest in an isolated session and retains copy/return actions', async () => {
  const view = render(), guest = view.get('webview')
  expect(guest.attributes('src')).toBe('https://pan.quark.cn/s/abc?pwd=a1B2')
  expect(guest.attributes('partition')).toBe(SHARE_BROWSER_PARTITION)
  expect(guest.attributes()).toHaveProperty('allowpopups')
  expect(guest.attributes('preload')).toBeUndefined()
  expect(view.text()).toContain('提取码：a1B2')
  await view.findAll('button').find(button => button.text().includes('复制链接'))!.trigger('click')
  await view.get('.return-button').trigger('click')
  expect(view.emitted('copy')).toHaveLength(1)
  expect(view.emitted('close')).toHaveLength(1)
})

it('keeps redirect URLs out of the src binding and supports native guest history', async () => {
  const view = render(), guest = view.get('webview')
  const goBack = vi.fn(), reload = vi.fn()
  Object.assign(guest.element, { canGoBack: () => true, canGoForward: () => false, goBack, reload })
  await guest.trigger('dom-ready')
  await guest.trigger('did-navigate', { url: 'https://passport.example.test/login' })
  expect(view.get('.page-address span').text()).toBe('https://passport.example.test/login')
  expect(guest.attributes('src')).toBe('https://pan.quark.cn/s/abc?pwd=a1B2')
  await view.get('[aria-label="后退"]').trigger('click')
  await view.get('[aria-label="刷新分享页面"]').trigger('click')
  expect(goBack).toHaveBeenCalledOnce()
  expect(reload).toHaveBeenCalledOnce()
})

it('ignores aborted/subframe loads and offers an inline retry for genuine failures', async () => {
  const view = render(), guest = view.get('webview')
  await guest.trigger('did-fail-load', { errorCode: -3 })
  await guest.trigger('did-fail-load', { errorCode: -105, isMainFrame: false })
  expect(view.find('[role="alert"]').exists()).toBe(false)
  await guest.trigger('did-fail-load', { errorCode: -105, isMainFrame: true, errorDescription: 'offline fixture' })
  expect(view.get('[role="alert"]').text()).toContain('offline fixture')
  await view.get('.browser-error button').trigger('click')
  expect(view.find('[role="alert"]').exists()).toBe(false)
})
