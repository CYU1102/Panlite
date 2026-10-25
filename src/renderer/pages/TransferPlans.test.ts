// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TransferPlan, TransferPreview, TransferPreviewItem, TransferRun } from '@shared/transfer-plan'

const api = vi.hoisted(() => ({ listPlans: vi.fn(), savePlan: vi.fn(), removePlan: vi.fn(), previewPlan: vi.fn(), getPreview: vi.fn(), resolvePreview: vi.fn(), executePlan: vi.fn(), listRuns: vi.fn(), getReport: vi.fn(), exportPlan: vi.fn() }))
const electron = vi.hoisted(() => ({ listAccounts: vi.fn(), listFiles: vi.fn() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('../api/transfer-plans', () => ({ transferPlansApi: api }))
vi.mock('../api/ipc', () => ({ electronApi: electron }))
vi.mock('vue-router', () => ({ useRouter: () => navigation }))
import TransferPlans from './TransferPlans.vue'

const now = Date.now()
const source = { accountId: 'source-account', rootId: 'source-dir', rootPath: '/项目' }
const target = { accountId: 'target-account', rootId: 'target-dir', rootPath: '/归档' }
function plan(id = 'plan-a', name = '项目归档'): TransferPlan { return { id, name, source, target, exclude: ['*.tmp'], conflictPolicy: 'rename', version: 2, status: 'ready', latestPreviewId: `preview-${id}`, createdAt: now, updatedAt: now } }
function preview(planId = 'plan-a', executable = false): TransferPreview { return { id: `preview-${planId}`, planId, planVersion: 2, fingerprint: 'fingerprint', createdAt: now, complete: true, executable, failures: [], summary: { totalItems: 2, fileCount: 2, directoryCount: 0, addCount: 1, identicalCount: 0, changedCount: 0, conflictCount: 0, reviewCount: executable ? 0 : 1, skipCount: executable ? 1 : 0, transferBytes: 4096, tempBytes: 6144 } } }
function item(id = 'item-review', path = '报告.pdf'): TransferPreviewItem { return { id, relativePath: path, outputPath: path, source: { fileId: id, parentId: 'source-dir', name: path, isDir: false, size: 2048, updatedAt: now }, target: { fileId: 'target-id', parentId: 'target-dir', name: path, isDir: false, size: 2048, updatedAt: now }, category: 'review', action: 'review', requiresDecision: true, reason: '同名同大小但缺少可靠内容证据，需明确处理', mode: 'staged_transfer' } }
function run(id = 'run-a'): TransferRun { return { id, planId: 'plan-a', previewId: 'preview-plan-a', planVersion: 2, taskId: 'task-a', taskStatus: 'success', status: 'completed', totalItems: 80, succeeded: 78, skipped: 1, failed: 0, uncertain: 1, createdAt: now, updatedAt: now } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let wrapper: VueWrapper | undefined

beforeEach(() => {
  vi.resetAllMocks()
  api.listPlans.mockResolvedValue({ success: true, plans: [plan(), plan('plan-b', '照片迁移')] })
  api.getPreview.mockImplementation(input => Promise.resolve({ success: true, preview: preview(input.previewId === 'preview-plan-b' ? 'plan-b' : 'plan-a'), items: [item()], total: 1, page: input.page || 1, pageSize: input.pageSize || 50 }))
  api.listRuns.mockResolvedValue({ success: true, runs: [] })
  api.previewPlan.mockResolvedValue({ success: true, preview: preview() })
  api.resolvePreview.mockResolvedValue({ success: true, preview: preview('plan-a', true) })
  api.savePlan.mockResolvedValue({ success: true, plan: { ...plan(), version: 3, name: '保存后的计划', latestPreviewId: undefined, status: 'draft' } })
  api.removePlan.mockResolvedValue({ success: true })
  api.executePlan.mockResolvedValue({ success: true, run: run(), taskId: 'task-a' })
  api.getReport.mockImplementation(input => Promise.resolve({ success: true, run: run(input.runId), items: [{ itemId: 'result-a', relativePath: '报告.pdf', outputPath: '/归档/报告.pdf', status: 'uncertain', error: '远端返回结果需要核对', updatedAt: now }], total: 80, page: input.page || 1, pageSize: 50 }))
  api.exportPlan.mockResolvedValue({ success: true, fileName: 'migration-plan.json', json: '{"plan":"fixture"}' })
  electron.listAccounts.mockResolvedValue({ success: true, accounts: [{ id: 'source-account', nickname: '工作盘', platform: 'quark', status: 'active' }, { id: 'target-account', nickname: '归档盘', platform: 'webdav', status: 'active' }] })
  electron.listFiles.mockResolvedValue({ success: true, files: [], hasMore: false, parentId: '0' })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render() { wrapper = mount(TransferPlans); await flushPromises(); return wrapper }
function button(view: VueWrapper, text: string) { const match = view.findAll('button').find(control => control.text() === text); if (!match) throw new Error(`Button not found: ${text}`); return match }

it('preserves edited configuration on a version conflict and sends the expected saved version', async () => {
  const view = await render()
  await view.get('input[aria-label="计划名称"]').setValue('更新项目归档')
  await view.get('textarea[aria-label="排除规则"]').setValue('*.tmp\n**/缓存/**')
  await view.get('select[aria-label="冲突策略"]').setValue('overwrite')
  api.savePlan.mockResolvedValueOnce({ success: false, code: 'VERSION_CONFLICT', error: '计划配置已更新，请重新读取后再保存' })
  await view.get('form.plan-form').trigger('submit'); await flushPromises()
  expect(api.savePlan).toHaveBeenCalledWith({ id: 'plan-a', expectedVersion: 2, name: '更新项目归档', source, target, exclude: ['*.tmp', '**/缓存/**'], conflictPolicy: 'overwrite' })
  expect(view.text()).toContain('计划配置已更新')
  expect(view.get('input[aria-label="计划名称"]').element).toHaveProperty('value', '更新项目归档')
  expect(button(view, '重新预演').attributes('disabled')).toBeDefined()
})

it('selects real source and target directories while creating a saved plan', async () => {
  api.listPlans.mockResolvedValue({ success: true, plans: [] })
  const view = await render()
  await view.get('input[aria-label="计划名称"]').setValue('新的目录计划')
  await button(view, '选择源目录').trigger('click')
  electron.listFiles.mockResolvedValueOnce({ success: true, parentId: '0', hasMore: false, files: [{ id: 'chosen-source', name: '项目资料', path: '/项目资料', isDir: true }] })
  await view.get('select[aria-label="目录账号"]').setValue('source-account'); await flushPromises()
  await view.get('.folder').trigger('click'); await flushPromises()
  await button(view, '选择当前目录').trigger('click')
  await button(view, '选择目标目录').trigger('click')
  await view.get('select[aria-label="目录账号"]').setValue('target-account'); await flushPromises()
  await button(view, '选择当前目录').trigger('click')
  await view.get('form.plan-form').trigger('submit'); await flushPromises()
  expect(api.savePlan).toHaveBeenCalledWith(expect.objectContaining({ name: '新的目录计划', source: { accountId: 'source-account', rootId: 'chosen-source', rootPath: '/项目资料' }, target: { accountId: 'target-account', rootId: '0', rootPath: '/' } }))
  expect(electron.listFiles).toHaveBeenCalledWith('source-account', 'chosen-source', false)
})

it('ignores preview responses belonging to a previously selected plan', async () => {
  const view = await render()
  const late = deferred<unknown>()
  api.getPreview.mockReturnValueOnce(late.promise)
  await view.findAll('.plan-item')[0].trigger('click')
  api.getPreview.mockResolvedValueOnce({ success: true, preview: preview('plan-b'), items: [item('photo', '个人照片.jpg')], total: 1, page: 1, pageSize: 50 })
  await view.findAll('.plan-item')[1].trigger('click'); await flushPromises()
  late.resolve({ success: true, preview: preview(), items: [item()], total: 1, page: 1, pageSize: 50 }); await flushPromises()
  expect(view.get('.preview-table').text()).toContain('个人照片.jpg')
  expect(view.get('.preview-table').text()).not.toContain('报告.pdf')
  expect(view.get('input[aria-label="计划名称"]').element).toHaveProperty('value', '照片迁移')
})

it('does not call equal name and size identical and saves a concrete per-file decision', async () => {
  const view = await render()
  expect(view.get('.preview-table').text()).toContain('同名同大小但缺少可靠内容证据')
  expect(view.get('.preview-table').text()).toContain('待核对')
  expect(button(view, '执行此预演').attributes('disabled')).toBeDefined()
  await view.get('select[aria-label="处理报告.pdf"]').setValue('skip')
  await button(view, '保存此项处理').trigger('click'); await flushPromises()
  expect(api.resolvePreview).toHaveBeenCalledWith({ previewId: 'preview-plan-a', decisions: [{ itemId: 'item-review', action: 'skip' }] })
  expect(view.text()).toContain('已保存 1 项处理方式')
})

it('keeps a rejected decision selected and blocks overwrite for a file-directory conflict', async () => {
  const conflict = { ...item(), target: { ...item().target!, isDir: true }, category: 'conflict' }
  api.getPreview.mockResolvedValue({ success: true, preview: preview(), items: [conflict], total: 1, page: 1, pageSize: 50 })
  const view = await render()
  expect(view.get('select[aria-label="处理报告.pdf"]').findAll('option').map(option => option.attributes('value'))).not.toContain('overwrite')
  await view.get('input[aria-label="选择本页待核对项"]').setValue(true)
  await view.get('select[aria-label="批量处理方式"]').setValue('overwrite')
  await button(view, '处理所选 1 项').trigger('click'); await flushPromises()
  expect(api.resolvePreview).not.toHaveBeenCalled()
  expect(view.text()).toContain('文件与目录类型冲突')
  await view.get('select[aria-label="处理报告.pdf"]').setValue('rename')
  api.resolvePreview.mockResolvedValueOnce({ success: false, error: '预演记录保存失败' })
  await button(view, '保存此项处理').trigger('click'); await flushPromises()
  expect(view.get('select[aria-label="处理报告.pdf"]').element).toHaveProperty('value', 'rename')
  expect(view.text()).toContain('预演记录保存失败')
})

it('pages and filters the preview through bounded IPC requests', async () => {
  api.getPreview.mockImplementation(input => Promise.resolve({ success: true, preview: preview(), items: [item()], total: 101, page: input.page || 1, pageSize: input.pageSize || 50 }))
  const view = await render()
  await button(view, '下一页清单').trigger('click'); await flushPromises()
  expect(api.getPreview).toHaveBeenLastCalledWith({ previewId: 'preview-plan-a', category: undefined, page: 2, pageSize: 50 })
  await view.get('select[aria-label="预演分类"]').setValue('review'); await flushPromises()
  expect(api.getPreview).toHaveBeenLastCalledWith({ previewId: 'preview-plan-a', category: 'review', page: 1, pageSize: 50 })
  await view.get('select[aria-label="预演每页条数"]').setValue(100); await flushPromises()
  expect(api.getPreview).toHaveBeenLastCalledWith({ previewId: 'preview-plan-a', category: 'review', page: 1, pageSize: 100 })
  expect(view.findAll('.preview-table tbody tr')).toHaveLength(1)
})

it('handles a whole category by reading pages first and then submitting bounded decision batches', async () => {
  const view = await render()
  await view.get('select[aria-label="预演分类"]').setValue('review'); await flushPromises()
  api.getPreview.mockImplementation(input => Promise.resolve({ success: true, preview: preview(), items: input.pageSize === 100 ? Array.from({ length: input.page === 1 ? 100 : 1 }, (_, index) => item(`item-${(input.page - 1) * 100 + index}`, `文件-${index}.pdf`)) : [item()], total: 101, page: input.page || 1, pageSize: input.pageSize || 50 }))
  await button(view, '处理此分类全部待核对项').trigger('click')
  expect(api.resolvePreview).not.toHaveBeenCalled()
  await button(view, '确认处理此分类').trigger('click'); await flushPromises()
  expect(api.resolvePreview).toHaveBeenCalledTimes(2)
  expect(api.resolvePreview.mock.calls[0][0].decisions).toHaveLength(100)
  expect(api.resolvePreview.mock.calls[1][0].decisions).toEqual([{ itemId: 'item-100', action: 'skip' }])
  expect(view.text()).toContain('已保存此分类 101 项处理方式')
})

it('requires execution confirmation for the exact preview and guides stale previews to be regenerated', async () => {
  api.getPreview.mockResolvedValue({ success: true, preview: preview('plan-a', true), items: [{ ...item(), requiresDecision: false, action: 'skip' }], total: 1, page: 1, pageSize: 50 })
  const view = await render()
  await button(view, '执行此预演').trigger('click')
  expect(api.executePlan).not.toHaveBeenCalled()
  expect(view.get('.execution-confirmation').text()).toContain('preview-plan-a')
  api.executePlan.mockResolvedValueOnce({ success: false, code: 'STALE_PREVIEW', error: '源文件发生变化' })
  await button(view, '确认执行此版本').trigger('click'); await flushPromises()
  expect(api.executePlan).toHaveBeenCalledExactlyOnceWith({ planId: 'plan-a', previewId: 'preview-plan-a' })
  expect(view.text()).toContain('此预演需要重新生成')
  expect(view.text()).toContain('源文件发生变化')
  expect(button(view, '执行此预演').attributes('disabled')).toBeDefined()
  await button(view, '重新读取目录并预演').trigger('click'); await flushPromises()
  expect(api.previewPlan).toHaveBeenCalledExactlyOnceWith('plan-a')
})

it('blocks execution of incomplete ranges and marks estimates as partial', async () => {
  api.getPreview.mockResolvedValue({ success: true, preview: { ...preview('plan-a', true), complete: false, failures: [{ side: 'target', path: '/归档/限制目录', reason: '无读取权限' }] }, items: [item()], total: 1, page: 1, pageSize: 50 })
  const view = await render()
  expect(view.text()).toContain('范围未完整读取')
  expect(view.text()).toContain('以上仅为已列出项目的估算')
  expect(view.text()).toContain('无读取权限')
  expect(button(view, '执行此预演').attributes('disabled')).toBeDefined()
})

it('locks configuration and deletion while a linked execution is paused', async () => {
  api.listRuns.mockResolvedValue({ success: true, runs: [{ ...run(), status: 'running', taskStatus: 'paused' }] })
  const view = await render()
  expect(view.get('input[aria-label="计划名称"]').attributes('disabled')).toBeDefined()
  expect(button(view, '删除计划').attributes('disabled')).toBeDefined()
  expect(button(view, '重新预演').attributes('disabled')).toBeDefined()
  await view.findAll('.tab').find(control => control.text().startsWith('执行记录'))!.trigger('click'); await flushPromises()
  await button(view, '查看任务 / 暂停恢复').trigger('click')
  expect(navigation.push).toHaveBeenCalledWith({ path: '/tasks', query: { taskId: 'task-a', from: 'transfer-plans' } })
})

it('opens paginated per-file reports without treating uncertain results as success', async () => {
  api.listRuns.mockResolvedValue({ success: true, runs: [run()] })
  const view = await render()
  await view.findAll('.tab').find(control => control.text().startsWith('执行记录'))!.trigger('click'); await flushPromises()
  expect(view.get('.report-table').text()).toContain('待核对')
  expect(view.get('.report-table').text()).toContain('远端返回结果需要核对')
  await button(view, '下一页报告').trigger('click'); await flushPromises()
  expect(api.getReport).toHaveBeenLastCalledWith({ runId: 'run-a', page: 2, pageSize: 50 })
  expect(view.findAll('.report-table tbody tr')).toHaveLength(1)
})

it('preserves a plan when removal fails and requires explicit deletion confirmation', async () => {
  const view = await render()
  await button(view, '删除计划').trigger('click')
  expect(api.removePlan).not.toHaveBeenCalled()
  api.removePlan.mockResolvedValueOnce({ success: false, error: '计划仍有关联任务' })
  await button(view, '确认删除计划').trigger('click'); await flushPromises()
  expect(api.removePlan).toHaveBeenCalledExactlyOnceWith('plan-a')
  expect(view.text()).toContain('计划仍有关联任务')
  expect(view.findAll('.plan-item')).toHaveLength(2)
})

it('does not report an earlier save failure in a different plan', async () => {
  const view = await render()
  const pending = deferred<unknown>()
  api.savePlan.mockReturnValueOnce(pending.promise)
  await view.get('input[aria-label="计划名称"]').setValue('待保存名称')
  await view.get('form.plan-form').trigger('submit')
  await view.findAll('.plan-item')[1].trigger('click'); await flushPromises()
  pending.resolve({ success: false, error: '上个计划写入失败' }); await flushPromises()
  expect(view.text()).not.toContain('上个计划写入失败')
  expect(view.get('input[aria-label="计划名称"]').element).toHaveProperty('value', '照片迁移')
})

it('shows API export errors instead of creating a misleading download', async () => {
  const view = await render()
  api.exportPlan.mockResolvedValueOnce({ success: false, error: '预演已被移除，无法导出' })
  await button(view, '导出清单').trigger('click'); await flushPromises()
  expect(api.exportPlan).toHaveBeenCalledWith({ planId: 'plan-a', previewId: 'preview-plan-a', runId: undefined })
  expect(view.text()).toContain('预演已被移除，无法导出')
})

it('loads the linked run and its report after the selected preview is submitted', async () => {
  api.getPreview.mockResolvedValue({ success: true, preview: preview('plan-a', true), items: [{ ...item(), requiresDecision: false, action: 'skip' }], total: 1, page: 1, pageSize: 50 })
  const view = await render()
  api.listRuns.mockResolvedValue({ success: true, runs: [run()] })
  await button(view, '执行此预演').trigger('click')
  await button(view, '确认执行此版本').trigger('click'); await flushPromises()
  expect(api.executePlan).toHaveBeenCalledExactlyOnceWith({ planId: 'plan-a', previewId: 'preview-plan-a' })
  expect(api.getReport).toHaveBeenCalledExactlyOnceWith({ runId: 'run-a', page: 1, pageSize: 50 })
  expect(view.get('.report-table').text()).toContain('报告.pdf')
  expect(view.text()).toContain('task-a')
})

it('ignores a late report from the previously selected execution batch', async () => {
  api.listRuns.mockResolvedValue({ success: true, runs: [run(), run('run-b')] })
  const view = await render()
  await view.findAll('.tab').find(control => control.text().startsWith('执行记录'))!.trigger('click'); await flushPromises()
  const lateReport = deferred<unknown>()
  api.getReport.mockReturnValueOnce(lateReport.promise)
  await button(view, '刷新报告').trigger('click')
  api.getReport.mockResolvedValueOnce({ success: true, run: run('run-b'), items: [{ itemId: 'new-result', relativePath: '新批次.pdf', outputPath: '/归档/新批次.pdf', status: 'success', updatedAt: now }], total: 1, page: 1, pageSize: 50 })
  await view.get('select[aria-label="执行批次"]').setValue('run-b'); await flushPromises()
  lateReport.resolve({ success: true, run: run(), items: [{ itemId: 'old-result', relativePath: '旧批次.pdf', outputPath: '/旧批次.pdf', status: 'failed', updatedAt: now }], total: 1, page: 1, pageSize: 50 }); await flushPromises()
  expect(view.get('.report-table').text()).toContain('新批次.pdf')
  expect(view.get('.report-table').text()).not.toContain('旧批次.pdf')
})

it('downloads the real exported JSON for the selected preview', async () => {
  const createObjectURL = vi.fn().mockReturnValue('blob:fixture-plan')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = await render()
  await button(view, '导出清单').trigger('click'); await flushPromises()
  expect(api.exportPlan).toHaveBeenCalledWith({ planId: 'plan-a', previewId: 'preview-plan-a', runId: undefined })
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
  expect(createObjectURL.mock.calls[0][0].type).toBe('application/json;charset=utf-8')
  expect(click).toHaveBeenCalledOnce()
  expect(document.querySelector('a[download="migration-plan.json"]')).toBeNull()
})

it('lets the user explicitly discard a conflicting draft and read the latest configuration', async () => {
  const view = await render()
  await view.get('input[aria-label="计划名称"]').setValue('本地草稿')
  api.savePlan.mockResolvedValueOnce({ success: false, code: 'PLAN_VERSION', error: '计划已被更新，请刷新后重试' })
  await view.get('form.plan-form').trigger('submit'); await flushPromises()
  api.listPlans.mockResolvedValueOnce({ success: true, plans: [{ ...plan(), version: 3, name: '最新配置' }] })
  await button(view, '放弃草稿并读取最新配置').trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="计划名称"]').element).toHaveProperty('value', '最新配置')
  expect(view.text()).toContain('配置 v3')
  expect(view.text()).not.toContain('计划已被更新，请刷新后重试')
})

it('keeps a pending decision locked when its plan is reopened', async () => {
  const view = await render()
  const pending = deferred<unknown>()
  api.resolvePreview.mockReturnValueOnce(pending.promise)
  await view.get('select[aria-label="处理报告.pdf"]').setValue('skip')
  await button(view, '保存此项处理').trigger('click')
  await view.findAll('.plan-item')[0].trigger('click'); await flushPromises()
  expect(view.get('select[aria-label="处理报告.pdf"]').attributes('disabled')).toBeDefined()
  expect(button(view, '保存此项处理').attributes('disabled')).toBeDefined()
  pending.resolve({ success: true, preview: preview('plan-a', true) }); await flushPromises()
  expect(api.resolvePreview).toHaveBeenCalledOnce()
  expect(view.get('select[aria-label="处理报告.pdf"]').attributes('disabled')).toBeUndefined()
})

it('refreshes the batch label and unlocks completed plan configuration when its report reaches a terminal state', async () => {
  api.listPlans.mockResolvedValue({ success: true, plans: [{ ...plan(), status: 'running', latestRunId: 'run-a' }] })
  api.listRuns.mockResolvedValue({ success: true, runs: [{ ...run(), status: 'running', taskStatus: 'running' }] })
  const view = await render()
  expect(view.get('input[aria-label="计划名称"]').attributes('disabled')).toBeDefined()
  api.listPlans.mockResolvedValue({ success: true, plans: [{ ...plan(), status: 'completed', latestRunId: 'run-a' }] })
  await view.findAll('.tab').find(control => control.text().startsWith('执行记录'))!.trigger('click'); await flushPromises()
  expect(view.get('select[aria-label="执行批次"]').text()).toContain('已完成')
  expect(view.get('select[aria-label="执行批次"]').text()).not.toContain('执行中')
  expect(view.get('input[aria-label="计划名称"]').attributes('disabled')).toBeUndefined()
})
