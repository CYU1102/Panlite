// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ prepareFilePreview: vi.fn(), cleanupFilePreview: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import FilePreviewDialog from './FilePreviewDialog.vue'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  api.cleanupFilePreview.mockResolvedValue({ success: true })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.resetAllMocks() })

function result(sessionId: string, kind = 'text', extra = {}) {
  return { success: true, preview: { sessionId, kind, fileName: 'sample.txt', size: 123, mimeType: 'text/plain', content: sessionId, expiresAt: Date.now() + 60000, ...extra } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function render() {
  wrapper = mount(FilePreviewDialog, { props: { modelValue: true, accountId: 'account', fileId: 'one', fileName: 'sample.txt' }, global: {
    stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } },
  } })
  await flushPromises()
  return wrapper
}

describe('preview session lifecycle', () => {
  it('discards and releases results arriving after a parent closes the dialog', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    api.prepareFilePreview.mockReturnValue(pending.promise)
    const view = await render()
    await view.setProps({ modelValue: false })
    pending.resolve(result('late'))
    await flushPromises()
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('late')
    expect(view.find('.text-preview').exists()).toBe(false)
  })

  it('ignores an old failure after a newer file has loaded', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    api.prepareFilePreview.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('new'))
    const view = await render()
    await view.setProps({ fileId: 'two', fileName: 'new.txt' })
    await flushPromises()
    pending.reject(new Error('old network failure'))
    await flushPromises()
    expect(view.get('.text-preview').text()).toBe('new')
    expect(view.text()).not.toContain('old network failure')
  })

  it('does not allow late successful requests to replace the selected file', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    api.prepareFilePreview.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('new'))
    const view = await render()
    await view.setProps({ fileId: 'two' })
    await flushPromises()
    pending.resolve(result('old'))
    await flushPromises()
    expect(view.get('.text-preview').text()).toBe('new')
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('old')
    view.unmount()
    wrapper = undefined
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('new')
  })

  it('releases unsafe assets and offers a fresh retry', async () => {
    api.prepareFilePreview.mockResolvedValueOnce(result('unsafe', 'image', { assetUrl: 'file:///C:/secret.png' })).mockResolvedValueOnce(result('retry'))
    const view = await render()
    expect(view.text()).toContain('不安全的预览地址')
    expect(view.find('img').exists()).toBe(false)
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('unsafe')
    await view.findAll('button').find(button => button.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(view.get('.text-preview').text()).toBe('retry')
  })
})

describe('preview content and playback', () => {
  it('supports playback speed and unloads media before releasing the session', async () => {
    api.prepareFilePreview.mockResolvedValue(result('video', 'video', { assetUrl: 'panlite-preview://session/video', delivery: 'stream' }))
    const view = await render()
    const media = view.get('video').element as HTMLVideoElement
    expect(media.preload).toBe('metadata')
    await view.get('select').setValue('1.5')
    await view.get('video').trigger('loadedmetadata')
    expect(media.playbackRate).toBe(1.5)
    expect(view.text()).toContain('在线按需加载')
    await view.setProps({ modelValue: false })
    expect(media.pause).toHaveBeenCalled()
    expect(media.hasAttribute('src')).toBe(false)
    expect(media.load).toHaveBeenCalled()
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('video')
  })

  it('explains decoding errors and releases failed media', async () => {
    api.prepareFilePreview.mockResolvedValue(result('audio', 'audio', { assetUrl: 'panlite-preview://session/audio' }))
    const view = await render()
    Object.defineProperty(view.get('audio').element, 'error', { value: { code: 4 } })
    await view.get('audio').trigger('error')
    await flushPromises()
    expect(view.text()).toContain('无法解码')
    expect(view.find('audio').exists()).toBe(false)
    expect(api.cleanupFilePreview).toHaveBeenCalledWith('audio')
  })

  it('shows Office extraction limitations and treats embedded markup as text', async () => {
    api.prepareFilePreview.mockResolvedValue(result('office', 'office', { content: '<script>alert(1)</script>' }))
    const view = await render()
    expect(view.text()).toContain('不保留原文档排版')
    expect(view.get('.text-preview').text()).toBe('<script>alert(1)</script>')
    expect(view.find('script').exists()).toBe(false)
  })

  it('does not render executable links or HTML from Markdown', async () => {
    api.prepareFilePreview.mockResolvedValue(result('markdown', 'markdown', { content: '# 标题\n[安全](https://example.com) [危险](javascript:alert)\n<img src=x onerror=alert(1)>' }))
    const view = await render()
    expect(view.get('h1').text()).toBe('标题')
    expect(view.findAll('a')).toHaveLength(1)
    expect(view.get('a').attributes('href')).toBe('https://example.com/')
    expect(view.find('img').exists()).toBe(false)
  })
})
