// @vitest-environment jsdom
import { mount, shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'
import type { AiLocalToolStatus, AiProviderConfig } from '@shared/ai-types'

const api = vi.hoisted(() => ({
  aiLocalToolsGet: vi.fn(), aiProcessingPolicyGet: vi.fn(), aiDocumentList: vi.fn(), aiTaskList: vi.fn(), aiProviderGet: vi.fn(), aiConversationList: vi.fn(), aiConversationMessages: vi.fn(),
  onAiProviderChanged: vi.fn(), onAiTaskUpdated: vi.fn(), onAiAskStreamEvent: vi.fn(),
}))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('../components/AiProviderDialog.vue', () => ({ default: { name: 'AiProviderDialog', template: '<div />' } }))
vi.mock('../components/AiLocalToolsDialog.vue', () => ({ default: { name: 'AiLocalToolsDialog', template: '<div />' } }))
vi.mock('../components/AiDocumentWorkflow.vue', () => ({ default: { name: 'AiDocumentWorkflow', props: ['documents'], emits: ['citation'], template: '<div />' } }))
vi.mock('../components/AiCitationPreview.vue', () => ({ default: { name: 'AiCitationPreview', props: ['modelValue', 'citation'], template: '<div />' } }))
import AiWorkspace from './AiWorkspace.vue'

let wrapper: VueWrapper | undefined
const unconfigured: AiProviderConfig = { id: 'default', name: '未配置', type: 'openai-compatible', baseUrl: '', model: '', transcriptionModel: '', embeddingModel: '', hasApiKey: false }
const tool = (key: AiLocalToolStatus['key'], ready = false): AiLocalToolStatus => ({ key, available: ready, ready }) as AiLocalToolStatus
beforeEach(() => {
  api.aiDocumentList.mockResolvedValue({ success: true, documents: [] })
  api.aiTaskList.mockResolvedValue({ success: true, tasks: [] })
  api.aiProviderGet.mockResolvedValue({ success: true, config: unconfigured })
  api.aiConversationList.mockResolvedValue({ success: true, conversations: [] })
  api.aiLocalToolsGet.mockResolvedValue({ success: true, tools: [] })
  api.aiProcessingPolicyGet.mockResolvedValue({ success: true, policy: { allowModelFallback: false, useSemanticIndex: false } })
  for (const listener of [api.onAiProviderChanged, api.onAiTaskUpdated, api.onAiAskStreamEvent]) listener.mockReturnValue(vi.fn())
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: vi.fn() }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.resetAllMocks() })

async function render(attach = false) {
  wrapper = shallowMount(AiWorkspace, { attachTo: attach ? document.body : undefined, global: { stubs: {
    ElDrawer: { name: 'ElDrawer', props: ['modelValue'], emits: ['update:modelValue'], template: '<aside class="source-panel"><slot /></aside>' },
    AiDocumentWorkflow: { name: 'AiDocumentWorkflow', props: ['documents'], emits: ['citation'], template: '<div />' },
    AiCitationPreview: { name: 'AiCitationPreview', props: ['modelValue', 'citation'], template: '<div />' },
  } } })
  await flushPromises()
  return wrapper
}
function card(view: VueWrapper, name: string) {
  return view.findAll('.capability-grid article').find(item => item.get('h4').text() === name)!
}
function refreshButton(view: VueWrapper) {
  return view.findAll('button').find(button => /重新检测能力|检测能力中/.test(button.text()))!
}

describe('AI capability availability', () => {
  it('filters the document library by status and real parsing notices without hiding data permanently', async () => {
    const base = { sourceType: 'local', extension: 'pdf', size: 1000, createdAt: Date.now() }
    api.aiDocumentList.mockResolvedValue({ success: true, documents: [
      { ...base, id: 'ready', name: '合同.pdf', status: 'ready', parseMessage: '本地文字提取；第 3 页没有文字层' },
      { ...base, id: 'failed', name: '扫描件.pdf', status: 'failed', errorMessage: '未安装中文 OCR 语言包' },
    ] })
    const view = await render()
    await view.findAll('.workspace-tabs button').find(button => button.text().startsWith('文档库'))!.trigger('click')
    expect(view.findAll('.document-row:not(.head)')).toHaveLength(2)
    expect(view.text()).toContain('第 3 页没有文字层')
    await view.get('select[aria-label="筛选文档状态"]').setValue('failed')
    expect(view.findAll('.document-row:not(.head)')).toHaveLength(1)
    expect(view.get('.document-row:not(.head)').text()).toContain('未安装中文 OCR 语言包')
    await view.get('input[aria-label="搜索文档"]').setValue('合同')
    expect(view.text()).toContain('没有匹配的文档')
    await view.get('select[aria-label="筛选文档状态"]').setValue('all')
    expect(view.get('.document-row:not(.head)').text()).toContain('合同.pdf')
    await view.get('button[aria-label="清除文档搜索"]').trigger('click')
    expect(view.findAll('.document-row:not(.head)')).toHaveLength(2)
  })
  it('does not claim default processing options are saved when their read fails', async () => {
    api.aiProcessingPolicyGet.mockResolvedValue({ success: false, error: '读取失败' })
    const view = await render()
    expect(view.get('.processing-strip').text()).toContain('处理方式读取失败')
    expect(view.get('.processing-strip').text()).not.toContain('模型补充识别关闭')
    expect(view.get('.processing-strip').text()).not.toContain('本地关键词索引')
  })
  it('separates document scope from history and can collapse the source panel', async () => {
    const view = await render()
    await view.findAll('.workspace-tabs button').find(button => button.text() === '文档问答')!.trigger('click')
    const toggle = view.findAll('.chat-tools button').find(button => button.text() === '文档与来源')!
    await toggle.trigger('click')
    expect(view.get('.source-panel').text()).toContain('全部可用文档')
    expect(view.find('.history-panel .scope-title').exists()).toBe(false)
    await view.get('button[aria-label="关闭文档与来源"]').trigger('click')
    expect(view.find('.source-panel').exists()).toBe(false)
  })
  it('opens answer citations in the source panel and can expand the original without showing two previews', async () => {
    const citation = { documentId: 'doc', documentName: '合同.pdf', pageNumber: 3, quote: '预算 42 万元' }
    api.aiDocumentList.mockResolvedValue({ success: true, documents: [{ id: 'doc', name: '合同.pdf', extension: 'pdf', status: 'ready', size: 100, createdAt: Date.now() }] })
    api.aiConversationList.mockResolvedValue({ success: true, conversations: [{ id: 'conversation', title: '预算核对', documentIds: ['doc'] }] })
    api.aiConversationMessages.mockResolvedValue({ success: true, messages: [{ id: 'answer', role: 'assistant', content: '预算为 42 万元。', citations: [citation] }] })
    const view = await render()
    await view.findAll('.workspace-tabs button').find(button => button.text() === '文档问答')!.trigger('click')
    await view.get('.citations summary').trigger('click'); await flushPromises()
    expect(view.findComponent({ name: 'AiCitationPreview' }).props('citation')).toEqual(citation)
    expect(view.get('.source-content').text()).toContain('合同.pdf')
    await view.get('.expand-citation').trigger('click'); await flushPromises()
    expect(view.findAllComponents({ name: 'AiCitationPreview' })).toHaveLength(1)
    expect(view.get('.source-content').findComponent({ name: 'AiCitationPreview' }).exists()).toBe(false)
    view.findComponent({ name: 'AiCitationPreview' }).vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(view.get('.source-content').findComponent({ name: 'AiCitationPreview' }).exists()).toBe(true)
    await view.findAll('.workspace-tabs button').find(button => button.text().startsWith('文档库'))!.trigger('click')
    expect(view.findComponent({ name: 'AiCitationPreview' }).exists()).toBe(false)
  })
  it('moves keyboard focus into sources and restores the toolbar trigger after Escape', async () => {
    const view = await render(true)
    await view.findAll('.workspace-tabs button').find(button => button.text() === '文档问答')!.trigger('click')
    const toggle = view.findAll('.chat-tools button').find(button => button.text() === '文档与来源')!
    ;(toggle.element as HTMLElement).focus()
    await toggle.trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(view.get('.source-body').element)
    await view.get('.source-body').trigger('keydown', { key: 'Escape' }); await flushPromises()
    expect(view.find('.source-body').exists()).toBe(false)
    expect(document.activeElement).toBe(toggle.element)
  })
  it('uses a modal drawer at compact width and keeps Tab inside its controls', async () => {
    wrapper = mount(AiWorkspace, { attachTo: document.body, global: { stubs: { ElDialog: { template: '<section><slot /></section>' }, Teleport: true } } })
    await flushPromises()
    const view = wrapper
    await view.findAll('.workspace-tabs button').find(button => button.text() === '文档问答')!.trigger('click')
    await view.findAll('.chat-tools button').find(button => button.text() === '文档与来源')!.trigger('click')
    await flushPromises()
    const drawer = view.findComponent({ name: 'ElDrawer' })
    expect(drawer.exists()).toBe(true)
    expect(drawer.props('modal')).toBe(true)
    const controls = Array.from(view.get('.source-body').element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    controls[controls.length - 1].focus()
    controls[controls.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(controls[0])
    controls[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })
  it('opens full-document processing with ready documents and routes its references to original preview', async () => {
    api.aiDocumentList.mockResolvedValue({ success: true, documents: [{ id: 'ready', name: '合同.pdf', status: 'ready' }, { id: 'pending', name: '解析中.pdf', status: 'processing' }] })
    const view = await render()
    await view.findAll('.workspace-tabs button').find(button => button.text() === '全文处理')!.trigger('click')
    await flushPromises()
    const workflow = view.findComponent({ name: 'AiDocumentWorkflow' })
    expect(workflow.props('documents')).toEqual([{ id: 'ready', name: '合同.pdf', status: 'ready' }])
    const citation = { documentId: 'ready', documentName: '合同.pdf', pageNumber: 2, quote: '预算42万元' }
    workflow.vm.$emit('citation', citation); await flushPromises()
    expect(view.findComponent({ name: 'AiCitationPreview' }).props('citation')).toEqual(citation)
  })
  it('distinguishes built-in text support from missing tools instead of marking everything ready', async () => {
    api.aiLocalToolsGet.mockResolvedValue({ success: true, tools: ['tesseract', 'libreoffice', 'whisper', 'ffmpeg'].map(key => tool(key as AiLocalToolStatus['key'])) })
    const view = await render()
    expect(view.findAll('.capability-grid article')).toHaveLength(6)
    expect(view.findAll('.capability-state.ready')).toHaveLength(2)
    expect(card(view, '图片 OCR').text()).toContain('需要配置')
    expect(card(view, 'Office 文档').text()).toContain('新格式可用')
    expect(card(view, 'PDF 文档').text()).toContain('文本层可用')
    expect(card(view, '音视频转写').text()).toContain('字幕优先')
    expect(view.text()).not.toContain('基础可用')
  })

  it('updates configured model states from both saved dialog values and provider events without claiming verified support', async () => {
    api.aiProcessingPolicyGet.mockResolvedValue({ success: true, policy: { allowModelFallback: true, useSemanticIndex: false } })
    const view = await render()
    const configured = { ...unconfigured, name: '测试模型', baseUrl: 'https://example.com/v1', model: 'vision-candidate', transcriptionModel: 'speech-candidate' }
    view.findComponent({ name: 'AiProviderDialog' }).vm.$emit('updated', configured)
    await flushPromises()
    expect(card(view, '图片 OCR').text()).toContain('模型待验证')
    expect(card(view, '音视频转写').text()).toContain('转写接口待验证')
    expect(card(view, '图片 OCR').get('.capability-state').classes()).not.toContain('ready')
    const onProviderChanged = api.onAiProviderChanged.mock.calls[0][0] as (config: AiProviderConfig) => void
    onProviderChanged(unconfigured)
    await flushPromises()
    expect(card(view, '图片 OCR').text()).toContain('需要配置')
    expect(card(view, '音视频转写').text()).toContain('字幕优先')
  })

  it('uses readiness updates from the local tools dialog immediately', async () => {
    const view = await render()
    view.findComponent({ name: 'AiLocalToolsDialog' }).vm.$emit('updated', [tool('tesseract', true), tool('libreoffice', true), tool('ffmpeg', true), tool('whisper', true)])
    await flushPromises()
    expect(card(view, '图片 OCR').text()).toContain('本地工具已就绪')
    expect(card(view, 'Office 文档').text()).toContain('转换工具已就绪')
    expect(card(view, '音视频转写').text()).toContain('本地工具已就绪')
    expect(view.findAll('.capability-state.ready')).toHaveLength(5)
  })

  it('redetects tools on request, disables concurrent requests, and replaces old availability', async () => {
    const view = await render()
    let resolve!: (value: unknown) => void
    api.aiLocalToolsGet.mockImplementationOnce(() => new Promise(res => { resolve = res }))
    await refreshButton(view).trigger('click')
    expect(refreshButton(view).attributes('disabled')).toBeDefined()
    expect(refreshButton(view).text()).toContain('检测能力中')
    await refreshButton(view).trigger('click')
    expect(api.aiLocalToolsGet).toHaveBeenCalledTimes(2)
    resolve({ success: true, tools: [tool('tesseract', true)] })
    await flushPromises()
    expect(refreshButton(view).attributes('disabled')).toBeUndefined()
    expect(card(view, '图片 OCR').text()).toContain('本地工具已就绪')
  })

  it.each(['rejection', 'failure-result'])('recovers from a detection %s and allows retry', async (failure) => {
    if (failure === 'rejection') api.aiLocalToolsGet.mockRejectedValueOnce(new Error('检测工具失败'))
    else api.aiLocalToolsGet.mockResolvedValueOnce({ success: false, error: '检测工具失败' })
    const view = await render()
    expect(ElMessage.error).toHaveBeenCalledWith('检测工具失败')
    expect(card(view, '图片 OCR').text()).toContain('需要配置')
    expect(view.text()).not.toContain('检测中')
    expect(refreshButton(view).attributes('disabled')).toBeUndefined()
    await refreshButton(view).trigger('click')
    await flushPromises()
    expect(api.aiLocalToolsGet).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a tool dialog update with an older background detection', async () => {
    let resolve!: (value: unknown) => void
    api.aiLocalToolsGet.mockImplementationOnce(() => new Promise(res => { resolve = res }))
    const view = await render()
    expect(card(view, '图片 OCR').text()).toContain('检测中')
    view.findComponent({ name: 'AiLocalToolsDialog' }).vm.$emit('updated', [tool('tesseract', true)])
    await flushPromises()
    resolve({ success: true, tools: [] })
    await flushPromises()
    expect(card(view, '图片 OCR').text()).toContain('本地工具已就绪')
    expect(refreshButton(view).attributes('disabled')).toBeUndefined()
  })
  it('keeps configured models unused for automatic extraction by default and reacts to saved processing policy', async () => {
    api.aiProviderGet.mockResolvedValue({ success: true, config: { ...unconfigured, baseUrl: 'https://example.com/v1', model: 'vision', transcriptionModel: 'speech' } })
    const view = await render()
    expect(card(view, '图片 OCR').text()).toContain('已关闭模型补充识别')
    expect(card(view, '图片 OCR').text()).not.toContain('模型待验证')
    expect(card(view, '压缩包解析').text()).toContain('本地关键词索引')
    view.findComponent({ name: 'AiLocalToolsDialog' }).vm.$emit('policyUpdated', { allowModelFallback: true, useSemanticIndex: true })
    await flushPromises()
    expect(card(view, '图片 OCR').text()).toContain('模型待验证')
    expect(card(view, '压缩包解析').text()).toContain('已启用语义向量索引')
    expect(view.findAll('.workspace-tabs button').some(button => button.text().includes('文档问答'))).toBe(true)
  })
  it('preserves a newly saved policy against an older in-flight settings read', async () => {
    let resolve!: (value: unknown) => void
    api.aiProcessingPolicyGet.mockImplementationOnce(() => new Promise(res => { resolve = res }))
    const view = await render()
    view.findComponent({ name: 'AiLocalToolsDialog' }).vm.$emit('policyUpdated', { allowModelFallback: false, useSemanticIndex: true })
    resolve({ success: true, policy: { allowModelFallback: false, useSemanticIndex: false } })
    await flushPromises()
    expect(card(view, '压缩包解析').text()).toContain('已启用语义向量索引')
  })
})
