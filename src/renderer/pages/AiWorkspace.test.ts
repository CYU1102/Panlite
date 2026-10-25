// @vitest-environment jsdom
import { mount, shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'
import type { AiLocalToolStatus, AiProviderConfig } from '@shared/ai-types'

const api = vi.hoisted(() => ({
  aiLocalToolsGet: vi.fn(), aiProcessingPolicyGet: vi.fn(), aiDocumentList: vi.fn(), aiTaskList: vi.fn(), aiProviderGet: vi.fn(), aiConversationList: vi.fn(), aiConversationMessages: vi.fn(),
  onAiProviderChanged: vi.fn(), onAiTaskUpdated: vi.fn(), onAiAskStreamEvent: vi.fn(),
  aiAskStreamStart: vi.fn(), aiAskStreamCancel: vi.fn(),
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
  api.aiAskStreamCancel.mockResolvedValue({ success: true })
  for (const listener of [api.onAiProviderChanged, api.onAiTaskUpdated, api.onAiAskStreamEvent]) listener.mockReturnValue(vi.fn())
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: vi.fn() }))
  vi.spyOn(ElMessage, 'info').mockImplementation(() => ({ close: vi.fn() }))
  vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({ close: vi.fn() }))
})

describe('answer regeneration', () => {
  const citation = { documentId: 'doc', documentName: '合同.pdf', pageNumber: 3, quote: '预算 42 万元' }
  const savedMessages = [
    { id: 'question', role: 'user', content: '预算是多少？' },
    { id: 'saved-answer', role: 'assistant', content: '原回答：预算 42 万元。', citations: [citation] },
  ]
  async function conversation() {
    api.aiProviderGet.mockResolvedValue({ success: true, config: { ...unconfigured, model: 'fixture', baseUrl: 'https://example.test' } })
    api.aiDocumentList.mockResolvedValue({ success: true, documents: [{ id: 'doc', name: '合同.pdf', status: 'ready', extension: 'pdf', size: 100 }] })
    api.aiConversationList.mockResolvedValue({ success: true, conversations: [{ id: 'conversation', title: '预算核对', documentIds: ['doc'] }] })
    api.aiConversationMessages.mockResolvedValue({ success: true, messages: savedMessages })
    api.aiAskStreamStart.mockResolvedValue({ success: true, requestId: 'regenerate-request' })
    const view = await render()
    await view.findAll('.workspace-tabs button').find(button => button.text() === '文档问答')!.trigger('click')
    return view
  }
  async function regenerate(view: VueWrapper) {
    await view.get('button[title="重新生成最后一个回答"]').trigger('click')
    await flushPromises()
  }
  async function event(type: 'delta' | 'error' | 'cancelled' | 'completed', extra = {}) {
    api.onAiAskStreamEvent.mock.calls[0][0]({ requestId: 'regenerate-request', type, ...extra })
    await flushPromises()
  }
  function expectSavedAnswer(view: VueWrapper) {
    expect(view.findAll('.message.assistant')).toHaveLength(1)
    expect(view.get('.message.assistant').text()).toContain('原回答：预算 42 万元。')
    expect(view.get('.citations summary').text()).toContain('合同.pdf')
  }

  it('retains the saved answer and citations when starting regeneration fails', async () => {
    const view = await conversation()
    api.aiAskStreamStart.mockRejectedValueOnce(new Error('离线'))
    await regenerate(view)
    expectSavedAnswer(view)
    expect(view.find('.thinking').exists()).toBe(false)
    expect(ElMessage.error).toHaveBeenCalledWith('离线')
  })
  it.each(['error', 'cancelled'] as const)('retains the saved answer after a partial stream ends with %s', async (type) => {
    const view = await conversation()
    await regenerate(view)
    expect(view.text()).toContain('原回答：预算 42 万元。')
    await event('delta', { delta: '未完成的新回答' })
    expect(view.findAll('.message.assistant')).toHaveLength(2)
    await event(type, { error: '生成中断' })
    expectSavedAnswer(view)
    expect(view.text()).not.toContain('未完成的新回答')
    expect(view.find('.thinking').exists()).toBe(false)
  })
  it('replaces the answer only after a successful stream and reloads persisted citations', async () => {
    const view = await conversation()
    await regenerate(view)
    await event('delta', { delta: '新的' })
    expect(view.text()).toContain('原回答：预算 42 万元。')
    const replacement = { ...savedMessages[1], id: 'replacement', content: '新的完整回答：预算 42 万元。' }
    api.aiConversationMessages.mockResolvedValue({ success: true, messages: [savedMessages[0], replacement] })
    await event('completed', { answer: replacement.content, citations: [citation] })
    expect(view.findAll('.message.assistant')).toHaveLength(1)
    expect(view.get('.message.assistant').text()).toContain(replacement.content)
    expect(view.text()).not.toContain('原回答：')
    expect(view.get('.citations summary').text()).toContain('合同.pdf')
  })
  it('ignores a late completed-answer refresh after the user selects another conversation', async () => {
    const view = await conversation()
    await regenerate(view)
    let resolve!: (value: unknown) => void
    const stale = new Promise(value => { resolve = value })
    api.aiConversationList.mockResolvedValue({ success: true, conversations: [
      { id: 'conversation', title: '预算核对', documentIds: ['doc'] },
      { id: 'other', title: '另一会话', documentIds: ['doc'] },
    ] })
    api.aiConversationMessages.mockImplementation(id => id === 'conversation' ? stale : Promise.resolve({ success: true, messages: [{ id: 'other-answer', role: 'assistant', content: '另一会话的回答' }] }))
    await event('completed', { answer: '重新生成的回答', citations: [citation] })
    await view.get('button[aria-label="展开或收起对话历史"]').trigger('click')
    await view.findAll('.conversation-main').find(button => button.text().includes('另一会话'))!.trigger('click')
    await flushPromises()
    expect(view.get('.message.assistant').text()).toContain('另一会话的回答')
    resolve({ success: true, messages: savedMessages })
    await flushPromises()
    expect(view.get('.message.assistant').text()).toContain('另一会话的回答')
    expect(view.get('.chat-toolbar').text()).toContain('另一会话')
  })
  it('does not revive a completed regeneration when its start response arrives later', async () => {
    const view = await conversation()
    let resolve!: (value: unknown) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(value => { resolve = value }))
    await regenerate(view)
    await event('error', { error: '快速失败' })
    expect(view.text()).toContain('原回答：预算 42 万元。')
    resolve({ success: true, requestId: 'regenerate-request' })
    await flushPromises()
    expect(view.find('.thinking').exists()).toBe(false)
    expectSavedAnswer(view)
    wrapper?.unmount(); wrapper = undefined
    expect(api.aiAskStreamCancel).not.toHaveBeenCalled()
  })
  it('remembers Stop before the start response and cancels once the request ID is known', async () => {
    const view = await conversation()
    let resolve!: (value: unknown) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await regenerate(view)
    await view.get('.stop-button').trigger('click')
    expect(api.aiAskStreamCancel).not.toHaveBeenCalled()
    resolve({ success: true, requestId: 'regenerate-request' }); await flushPromises()
    expect(api.aiAskStreamCancel).toHaveBeenCalledExactlyOnceWith('regenerate-request')
    await event('cancelled')
    expectSavedAnswer(view)
    expect(view.find('.thinking').exists()).toBe(false)
  })
  it('cancels a start response that arrives after leaving the workspace', async () => {
    const view = await conversation()
    let resolve!: (value: unknown) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await regenerate(view)
    wrapper?.unmount(); wrapper = undefined
    resolve({ success: true, requestId: 'abandoned-request' }); await flushPromises()
    expect(api.aiAskStreamCancel).toHaveBeenCalledExactlyOnceWith('abandoned-request')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })
  it('ignores buffered events belonging to an older request instead of adopting its ID', async () => {
    const view = await conversation()
    let resolve!: (value: unknown) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await regenerate(view)
    await event('error', { requestId: 'older-request', error: '过期错误' })
    await event('delta', { requestId: 'older-request', delta: '错误会话内容' })
    await event('delta', { delta: '当前回答' })
    resolve({ success: true, requestId: 'regenerate-request' }); await flushPromises()
    expect(view.text()).toContain('当前回答')
    expect(view.text()).not.toContain('错误会话内容')
    expect(ElMessage.error).not.toHaveBeenCalled()
    expect(view.find('.thinking').exists()).toBe(true)
    await event('cancelled')
    expectSavedAnswer(view)
  })
  it('keeps ordinary questions isolated from stale events during the start handshake', async () => {
    const view = await conversation()
    let resolve!: (value: unknown) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await view.get('textarea').setValue('新的问题')
    await view.findAll('.composer button').find(button => button.text() === '发送')!.trigger('click')
    await flushPromises()
    await event('error', { requestId: 'older-request', error: '过期错误' })
    expect(view.find('.thinking').exists()).toBe(true)
    resolve({ success: true, requestId: 'regenerate-request' }); await flushPromises()
    await event('delta', { delta: '新问题的回答' })
    expect(view.text()).toContain('新问题的回答')
    expect(ElMessage.error).not.toHaveBeenCalled()
    await event('cancelled')
  })
  it('keeps an active stream usable when cancel IPC rejects and permits a retry', async () => {
    const view = await conversation()
    await regenerate(view)
    api.aiAskStreamCancel.mockRejectedValueOnce(new Error('停止请求暂时失败'))
    await view.get('.stop-button').trigger('click'); await flushPromises()
    expect(ElMessage.warning).toHaveBeenCalledWith('停止请求暂时失败')
    expect(view.find('.thinking').exists()).toBe(true)
    await view.get('.stop-button').trigger('click'); await flushPromises()
    expect(api.aiAskStreamCancel).toHaveBeenCalledTimes(2)
    await event('cancelled')
    expectSavedAnswer(view)
  })
  it('preserves delta order when a buffered start is stopped and cancel later fails', async () => {
    const view = await conversation()
    let resolveStart!: (value: unknown) => void, rejectCancel!: (error: Error) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise(done => { resolveStart = done }))
    api.aiAskStreamCancel.mockImplementationOnce(() => new Promise((_resolve, fail) => { rejectCancel = fail }))
    await regenerate(view)
    await event('delta', { delta: 'first-' })
    await view.get('.stop-button').trigger('click')
    resolveStart({ success: true, requestId: 'regenerate-request' }); await flushPromises()
    expect(api.aiAskStreamCancel).toHaveBeenCalledOnce()
    await event('delta', { delta: 'second' })
    rejectCancel(new Error('取消失败')); await flushPromises()
    expect(view.findAll('.message.assistant')[1].text()).toContain('first-second')
    await event('cancelled')
    expectSavedAnswer(view)
  })
  it('ignores an ordinary question start rejection after the workspace has unmounted', async () => {
    const view = await conversation()
    let reject!: (error: Error) => void
    api.aiAskStreamStart.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await view.get('textarea').setValue('新的问题')
    await view.findAll('.composer button').find(button => button.text() === '发送')!.trigger('click')
    await flushPromises()
    wrapper?.unmount(); wrapper = undefined
    reject(new Error('迟到的错误')); await flushPromises()
    expect(ElMessage.error).not.toHaveBeenCalled()
  })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.resetAllMocks() })

async function render(attach = false) {
  wrapper = shallowMount(AiWorkspace, { attachTo: attach ? document.body : undefined, global: { stubs: {
    ElDrawer: { name: 'ElDrawer', props: ['modelValue'], emits: ['update:modelValue'], template: '<aside class="source-panel"><slot /></aside>' },
    AiDocumentWorkflow: { name: 'AiDocumentWorkflow', props: ['documents'], emits: ['citation'], template: '<div />' },
    AiCitationPreview: { name: 'AiCitationPreview', props: ['modelValue', 'citation'], template: '<div />' },
    AiMarkdown: { name: 'AiMarkdown', props: ['content'], template: '<div>{{ content }}</div>' },
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
