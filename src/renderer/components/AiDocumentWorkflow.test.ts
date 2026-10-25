// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiDocument } from '@shared/ai-types'
import type { AiWorkflowResponse, AiWorkflowRun, AiWorkflowTemplate } from '@shared/ai-workflow'
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), start: vi.fn(), resume: vi.fn(), cancel: vi.fn(), export: vi.fn(), templates: vi.fn(), saveTemplate: vi.fn(), deleteTemplate: vi.fn() }))
vi.mock('../api/ai-workflow', () => ({ aiWorkflowApi: api }))
import AiDocumentWorkflow from './AiDocumentWorkflow.vue'

let wrapper: VueWrapper | undefined
const docs = ['a', 'b', 'c'].map(id => ({ id, name: `${id}.pdf`, status: 'ready' } as AiDocument))
const citation = { documentId: 'a', documentName: 'a.pdf', chunkId: 'a-1', pageNumber: 2, quote: '预算42万元' }
const template: AiWorkflowTemplate = { id: 'template', name: '合同字段', fields: [{ key: 'budget', label: '预算', type: 'number' }], updatedAt: 1 }
function run(id: string, status: AiWorkflowRun['status'] = 'completed'): AiWorkflowRun {
  return { id, title: `任务 ${id}`, mode: 'summary', documentIds: ['a'], status, completedBatches: status === 'completed' ? 2 : 1, totalBatches: 2, createdAt: 1, updatedAt: 2,
    coverage: [{ documentId: 'a', documentName: 'a.pdf', sourceSha256: 'a'.repeat(64), totalChunks: 4, processedChunks: status === 'completed' ? 4 : 2, totalBatches: 2, completedBatches: status === 'completed' ? 2 : 1, sourceComplete: false, parseNotice: '扫描页2未解析', pendingRanges: status === 'completed' ? [] : ['第2章'] }],
    batches: [{ id: 'batch', index: 0, documentId: 'a', title: '第一章', status: 'completed', chunkCount: 2, attempts: 1 }],
    result: { sections: [{ documentId: 'a', title: '第一章', summary: `内容 ${id}`, citations: [citation] }], differences: [], fields: [], notice: '原件解析范围未确认' } }
}
const success = <T>(data: T): AiWorkflowResponse<T> => ({ success: true, data })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
function button(text: string) { return wrapper!.findAll('button').find(item => item.text() === text)! }
async function render() { wrapper = mount(AiDocumentWorkflow, { props: { documents: docs } }); await flushPromises(); return wrapper }
beforeEach(() => {
  api.list.mockResolvedValue(success([])); api.templates.mockResolvedValue(success([]))
  api.get.mockImplementation(async id => success(run(id)))
  api.start.mockResolvedValue(success(run('new', 'running')))
  api.resume.mockResolvedValue(success(run('old', 'running')))
  api.cancel.mockResolvedValue(success(run('old', 'cancelled')))
  api.export.mockResolvedValue({ success: true, filePath: 'C:/report.json' })
  api.deleteTemplate.mockResolvedValue(success(null))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers(); vi.resetAllMocks() })

describe('full document workflow controls', () => {
  it('only lists ready documents and preserves deliberate left/right selection order', async () => {
    const view = await render()
    await view.setProps({ documents: [...docs, { id: 'pending', name: 'pending.pdf', status: 'processing' } as AiDocument] })
    expect(view.findAll('.document-choice')).toHaveLength(3)
    expect(api.start).not.toHaveBeenCalled()
    await view.get('[aria-label="全文处理方式"]').setValue('compare')
    await view.get('input[value="b"]').setValue(true)
    expect(button('开始完整处理').attributes('disabled')).toBeDefined()
    await view.get('input[value="a"]').setValue(true)
    expect(view.get('input[value="c"]').attributes('disabled')).toBeDefined()
    expect(view.findAll('.document-choice')[1].text()).toContain('左侧')
    expect(view.findAll('.document-choice')[0].text()).toContain('右侧')
    await view.get('form').trigger('submit'); await flushPromises()
    expect(api.start).toHaveBeenCalledWith({ mode: 'compare', documentIds: ['b', 'a'], instruction: '' })
  })

  it('guards invalid comparison submits and removes unavailable documents from selection', async () => {
    const view = await render()
    for (const id of ['a', 'b', 'c']) await view.get(`input[value="${id}"]`).setValue(true)
    await view.get('[aria-label="全文处理方式"]').setValue('compare')
    await view.get('form').trigger('submit')
    expect(api.start).not.toHaveBeenCalled(); expect(view.text()).toContain('两份不同文档')
    await view.setProps({ documents: docs.slice(0, 2) })
    await view.get('form').trigger('submit'); await flushPromises()
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ['a', 'b'] }))
    expect(view.get('[aria-label="处理补充要求"]').attributes('maxlength')).toBe('2000')
  })

  it('creates, edits and deletes templates without mutating the saved field draft', async () => {
    const view = await render()
    await view.get('[aria-label="模板名称"]').setValue('合同字段')
    await view.get('[aria-label="字段 1 标识"]').setValue('budget')
    await view.get('[aria-label="字段 1 名称"]').setValue('预算')
    await view.get('[aria-label="字段 1 类型"]').setValue('number')
    api.saveTemplate.mockResolvedValue(success(template))
    await button('保存模板').trigger('click'); await flushPromises()
    expect(api.saveTemplate).toHaveBeenCalledWith({ name: '合同字段', fields: [{ key: 'budget', label: '预算', type: 'number' }] })
    await view.get('[aria-label="全文处理方式"]').setValue('extract')
    expect((view.get('[aria-label="提取模板"]').element as HTMLSelectElement).value).toBe('template')
    await view.get('[aria-label="字段 1 名称"]').setValue('项目预算')
    expect(template.fields[0].label).toBe('预算')
    api.saveTemplate.mockResolvedValue(success({ ...template, fields: [{ ...template.fields[0], label: '项目预算' }] }))
    await button('保存模板').trigger('click'); await flushPromises()
    expect(api.saveTemplate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'template', fields: [expect.objectContaining({ label: '项目预算' })] }))
    await button('删除模板').trigger('click'); await flushPromises()
    expect(api.deleteTemplate).toHaveBeenCalledWith('template')
    expect((view.get('[aria-label="提取模板"]').element as HTMLSelectElement).value).toBe('')
    expect(view.text()).toContain('已有处理结果仍保留')
  })

  it('restores persisted progress, resumes remaining batches, exports and opens citations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    api.list.mockResolvedValue(success([run('old', 'failed')]))
    api.get.mockResolvedValueOnce(success(run('old', 'failed'))).mockResolvedValue(success(run('old')))
    const view = await render()
    expect(view.get('progress').attributes('value')).toBe('1')
    expect(view.text()).toContain('扫描页2未解析')
    await button('继续未完成分段').trigger('click'); await flushPromises()
    expect(api.resume).toHaveBeenCalledWith('old')
    await vi.advanceTimersByTimeAsync(1500); await flushPromises()
    expect(view.get('progress').attributes('value')).toBe('2')
    expect(view.text()).toContain('原件解析范围未确认')
    await button('导出 JSON').trigger('click'); await flushPromises()
    expect(api.export).toHaveBeenCalledWith('old', 'json'); expect(view.text()).toContain('已导出')
    await button('a.pdf · 第 2 页').trigger('click')
    expect(view.emitted('citation')?.[0]).toEqual([citation])
  })

  it('ignores late run reads and stale control failures after another record is selected', async () => {
    api.list.mockResolvedValue(success([run('a', 'running'), run('b')]))
    const pendingRead = deferred<AiWorkflowResponse<AiWorkflowRun>>()
    api.get.mockImplementation(id => id === 'a' ? pendingRead.promise : Promise.resolve(success(run('b'))))
    const view = await render()
    await view.get('[aria-label="全文处理记录"]').setValue('b'); await flushPromises()
    pendingRead.resolve(success(run('a', 'running'))); await flushPromises()
    expect(view.get('.run-heading').text()).toContain('任务 b')
    api.get.mockResolvedValue(success(run('a', 'running')))
    await view.get('[aria-label="全文处理记录"]').setValue('a'); await flushPromises()
    const cancel = deferred<AiWorkflowResponse<AiWorkflowRun>>(); api.cancel.mockReturnValue(cancel.promise)
    await button('停止处理').trigger('click')
    api.get.mockResolvedValue(success(run('b')))
    await view.get('[aria-label="全文处理记录"]').setValue('b'); await flushPromises()
    cancel.reject(new Error('旧任务取消失败')); await flushPromises()
    expect(view.get('.run-heading').text()).toContain('任务 b'); expect(view.text()).not.toContain('旧任务取消失败')
  })

  it('keeps a new template draft and newly saved templates when old asynchronous results arrive', async () => {
    api.templates.mockResolvedValue(success([template]))
    const view = await render()
    await view.get('[aria-label="编辑提取模板"]').setValue('template')
    const save = deferred<AiWorkflowResponse<AiWorkflowTemplate>>(); api.saveTemplate.mockReturnValue(save.promise)
    await button('保存模板').trigger('click')
    await view.get('[aria-label="编辑提取模板"]').setValue('')
    await view.get('[aria-label="模板名称"]').setValue('新草稿')
    save.resolve(success({ ...template, name: '旧模板更新' })); await flushPromises()
    expect((view.get('[aria-label="模板名称"]').element as HTMLInputElement).value).toBe('新草稿')
    const staleTemplates = deferred<AiWorkflowResponse<AiWorkflowTemplate[]>>()
    api.templates.mockReturnValue(staleTemplates.promise)
    await button('刷新记录').trigger('click')
    api.saveTemplate.mockResolvedValue(success({ ...template, id: 'new-template', name: '新草稿' }))
    await button('保存模板').trigger('click'); await flushPromises()
    staleTemplates.resolve(success([template])); await flushPromises()
    expect(view.get('[aria-label="编辑提取模板"]').text()).toContain('新草稿')
  })

  it('stops polling after unmount and does not start model work from viewing records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    api.list.mockResolvedValue(success([run('old', 'running')]))
    api.get.mockResolvedValue(success(run('old', 'running')))
    await render(); expect(api.get).toHaveBeenCalledTimes(1)
    wrapper!.unmount(); wrapper = undefined
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.get).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled(); expect(api.resume).not.toHaveBeenCalled()
  })
})
