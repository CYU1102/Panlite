// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCitationPreviewResult } from '@shared/ai-citation-preview'
const api = vi.hoisted(() => ({ aiCitationPreview: vi.fn(), aiCitationPreviewCleanup: vi.fn() }))
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('../api/ai-citation-preview', () => ({ aiCitationPreviewApi: api }))
vi.mock('pdfjs-dist', () => pdfjs)
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }))
import AiCitationPreview from './AiCitationPreview.vue'

let wrapper: VueWrapper | undefined
const sessionId = '12345678-1234-1234-1234-123456789012'
const citation = { documentId: 'doc', documentName: 'audio.wav', chunkId: 'chunk', quote: '引用原文', startSeconds: 12.5, endSeconds: 15 }
function result(kind = 'audio', extra = {}): AiCitationPreviewResult {
  return { success: true, citation: { ...citation, ...extra }, preview: { sessionId, kind: kind as 'audio', fileName: 'audio.wav', mimeType: 'audio/wav', size: 10, expiresAt: Date.now() + 60000, assetUrl: `panlite-preview://session/${sessionId}` } }
}
beforeEach(() => {
  api.aiCitationPreviewCleanup.mockResolvedValue({ success: true })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.resetAllMocks() })
async function render() {
  wrapper = mount(AiCitationPreview, { props: { modelValue: true, citation }, global: { stubs: { ElDialog: { template: '<section><slot /></section>' } } } })
  await flushPromises(); return wrapper
}
describe('citation preview UI', () => {
  it('seeks only after metadata loads, supports repeated jumps and applies playback rate', async () => {
    api.aiCitationPreview.mockResolvedValue(result())
    const view = await render(), audio = view.get('audio')
    Object.defineProperty(audio.element, 'duration', { value: 100, configurable: true })
    await audio.trigger('loadedmetadata')
    expect((audio.element as HTMLMediaElement).currentTime).toBe(12.5)
    await view.get('select').setValue('1.5')
    expect((audio.element as HTMLMediaElement).playbackRate).toBe(1.5)
    ;(audio.element as HTMLMediaElement).currentTime = 40
    await view.get('.toolbar button').trigger('click')
    expect((audio.element as HTMLMediaElement).currentTime).toBe(12.5)
  })
  it('does not invent a seek target for whole-text transcription or out-of-range timestamps', async () => {
    api.aiCitationPreview.mockResolvedValue(result('audio', { startSeconds: undefined, endSeconds: undefined }))
    const view = await render()
    expect(view.text()).toContain('没有可靠时间戳'); expect(view.find('.toolbar button').exists()).toBe(false)
    api.aiCitationPreview.mockResolvedValue(result())
    await view.setProps({ citation: { ...citation, chunkId: 'other' } }); await flushPromises()
    const audio = view.get('audio'); Object.defineProperty(audio.element, 'duration', { value: 2 })
    await audio.trigger('loadedmetadata')
    expect(view.text()).toContain('超过原件时长')
  })
  it('discards and cleans a delayed result after the user closes the window', async () => {
    let resolve!: (value: AiCitationPreviewResult) => void
    api.aiCitationPreview.mockReturnValue(new Promise<AiCitationPreviewResult>(done => { resolve = done }))
    const view = await render()
    await view.setProps({ modelValue: false }); resolve(result()); await flushPromises()
    expect(api.aiCitationPreviewCleanup).toHaveBeenCalledWith(sessionId); expect(view.find('audio').exists()).toBe(false)
  })
  it('opens the cited PDF page and renders matching text geometry, with honest scan fallback', async () => {
    api.aiCitationPreview.mockResolvedValue(result('pdf', { pageNumber: 3, quote: 'Annual budget: 42' }))
    const getTextContent = vi.fn().mockResolvedValue({ items: [{ str: 'Annual budget: 42', transform: [12, 0, 0, 12, 20, 100], width: 100, height: 12 }] })
    const getPage = vi.fn().mockResolvedValue({ getViewport: () => ({ width: 600, height: 800, scale: 1, transform: [1, 0, 0, -1, 0, 800] }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent })
    const destroy = vi.fn().mockResolvedValue(undefined)
    pdfjs.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 5, getPage }), destroy })
    const view = await render()
    expect(getPage).toHaveBeenCalledWith(3); expect(view.findAll('.highlight')).toHaveLength(1)
    expect(view.text()).toContain('已高亮')
    getTextContent.mockResolvedValue({ items: [] })
    await view.findAll('.toolbar button')[2].trigger('click'); await flushPromises()
    expect(view.findAll('.highlight')).toHaveLength(0); expect(view.text()).toContain('无法精确高亮')
    await view.setProps({ modelValue: false }); await flushPromises()
    expect(destroy).toHaveBeenCalled()
  })
})
