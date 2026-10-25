// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutomationActionOption, AutomationRule, AutomationRun } from '@shared/automation-rules'

const api = vi.hoisted(() => ({ listActions: vi.fn(), listRules: vi.fn(), saveRule: vi.fn(), setEnabled: vi.fn(), removeRule: vi.fn(), dryRun: vi.fn(), runNow: vi.fn(), listRuns: vi.fn() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('../api/automation-rules', () => ({ automationRulesApi: api }))
vi.mock('vue-router', () => ({ useRouter: () => navigation }))
import AutomationRules from './AutomationRules.vue'

const now = Date.now()
const actions: AutomationActionOption[] = [{ kind: 'migration', planId: 'plan-a', planVersion: 3, name: '项目迁移' }, { kind: 'backup', planId: 'plan-b', planVersion: 2, name: '资料备份' }]
const key = (index = 0) => JSON.stringify([actions[index].kind, actions[index].planId, actions[index].planVersion])
function rule(id = 'rule-a', name = '项目自动归档'): AutomationRule { return { id, name, version: 4, enabled: true, action: { kind: 'migration', planId: 'plan-a', planVersion: 3 }, trigger: { kind: 'daily', time: '09:00', missed: 'skip' }, createdAt: now, updatedAt: now, triggerSince: now, nextRunAt: now + 86400000 } }
function run(id = 'run-a'): AutomationRun { return { id, ruleId: 'rule-a', ruleVersion: 4, status: 'success', eventKey: 'manual:one', createdAt: now, updatedAt: now, finishedAt: now, taskId: 'task-a', summary: '已核对并完成 10 个文件', action: rule().action } }
const preview = { executable: true, summary: '新增 10 项，内容一致 990 项', previewId: 'preview-a', itemCount: 1000, writeCount: 10, transferBytes: 4096 }
let wrapper: VueWrapper | undefined
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function button(view: VueWrapper, text: string) { const found = view.findAll('button').find(item => item.text() === text); if (!found) throw new Error(`Button not found: ${text}`); return found }
async function render() { wrapper = mount(AutomationRules); await flushPromises(); return wrapper }
beforeEach(() => {
  vi.resetAllMocks()
  api.listRules.mockResolvedValue({ success: true, rules: [rule(), rule('rule-b', '备份完成通知后续')] })
  api.listActions.mockResolvedValue({ success: true, actions })
  api.listRuns.mockImplementation(input => Promise.resolve({ success: true, runs: [], total: 0, page: input.page || 1, pageSize: input.pageSize || 25 }))
  api.saveRule.mockImplementation(input => Promise.resolve({ success: true, rule: { ...rule(input.id || 'new-rule', input.name), ...input, version: input.id ? 5 : 1 } }))
  api.setEnabled.mockImplementation(input => Promise.resolve({ success: true, rule: { ...rule(), version: 5, enabled: input.enabled } }))
  api.removeRule.mockResolvedValue({ success: true })
  api.dryRun.mockResolvedValue({ success: true, preview })
  api.runNow.mockResolvedValue({ success: true, run: run() })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.useRealTimers() })

it('loads saved rules and exact plan versions without scheduling, previewing, or mutating remotely', async () => {
  const view = await render()
  expect(view.get('select[aria-label="执行计划版本"]').element).toHaveProperty('value', key())
  expect(view.text()).toContain('规则 v4')
  expect(view.text()).toContain('应用关闭或电脑休眠时无法执行')
  for (const method of [api.saveRule, api.setEnabled, api.removeRule, api.dryRun, api.runNow]) expect(method).not.toHaveBeenCalled()
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
})

it('saves a new manual rule paused by default with the explicitly selected backup plan version', async () => {
  api.listRules.mockResolvedValue({ success: true, rules: [] })
  const view = await render()
  await view.get('input[aria-label="规则名称"]').setValue('手动归档')
  await view.get('select[aria-label="执行计划版本"]').setValue(key(1))
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith({ name: '手动归档', enabled: false, trigger: { kind: 'manual' }, action: { kind: 'backup', planId: 'plan-b', planVersion: 2 } })
  expect(view.text()).toContain('规则已保存')
  expect(api.runNow).not.toHaveBeenCalled()
})

it('validates interval bounds and saves merged missed runs with a configuration version check', async () => {
  const view = await render()
  await view.get('select[aria-label="触发方式"]').setValue('interval')
  await view.get('input[aria-label="间隔分钟"]').setValue(4)
  expect(button(view, '保存规则').attributes('disabled')).toBeDefined()
  await view.get('form').trigger('submit'); expect(api.saveRule).not.toHaveBeenCalled()
  await view.get('input[aria-label="间隔分钟"]').setValue(45)
  await view.get('select[aria-label="错过执行时间"]').setValue('run_once')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: 'rule-a', expectedVersion: 4, trigger: { kind: 'interval', everyMinutes: 45, missed: 'run_once' } }))
})

it('saves daily local time and an explicit skip policy', async () => {
  const view = await render()
  await view.get('input[aria-label="本机每天时间"]').setValue('22:35')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ trigger: { kind: 'daily', time: '22:35', missed: 'skip' } }))
  expect(view.text()).toContain('按电脑当前本地时区计算')
})

it('supports success triggers without offering a self reference and keeps server cycle errors visible', async () => {
  const view = await render()
  await view.get('select[aria-label="触发方式"]').setValue('task_success')
  const source = view.get('select[aria-label="成功触发来源规则"]')
  expect(source.findAll('option').map(item => item.attributes('value'))).toEqual(['', 'rule-b'])
  await source.setValue('rule-b')
  api.saveRule.mockResolvedValueOnce({ success: false, error: '规则不能形成循环触发', code: 'RULE_CYCLE' })
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ trigger: { kind: 'task_success', sourceRuleId: 'rule-b' } }))
  expect(view.text()).toContain('规则不能形成循环触发')
  expect(source.element).toHaveProperty('value', 'rule-b')
})

it('preserves the draft after a version conflict until an explicit reload', async () => {
  const view = await render()
  await view.get('input[aria-label="规则名称"]').setValue('我的草稿')
  api.saveRule.mockResolvedValueOnce({ success: false, error: '规则已更新', code: 'RULE_VERSION' })
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.get('input[aria-label="规则名称"]').element).toHaveProperty('value', '我的草稿')
  api.listRules.mockResolvedValueOnce({ success: true, rules: [{ ...rule(), name: '最新规则', version: 5 }] })
  await button(view, '放弃草稿并读取最新规则').trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="规则名称"]').element).toHaveProperty('value', '最新规则')
})

it('requires explicit selection of a newer plan version when the saved action becomes unavailable', async () => {
  api.listActions.mockResolvedValue({ success: true, actions: [{ ...actions[0], planVersion: 6 }] })
  const view = await render()
  expect(view.text()).toContain('版本已不可用，请重新选择')
  expect(button(view, '只读试运行').attributes('disabled')).toBeDefined()
  await view.get('select[aria-label="执行计划版本"]').setValue(JSON.stringify(['migration', 'plan-a', 6]))
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: 'migration', planId: 'plan-a', planVersion: 6 } }))
})

it('shows a read-only preview and blocks edits from being executed with that saved preview', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  expect(api.dryRun).toHaveBeenCalledWith('rule-a')
  expect(view.get('.preview-result').text()).toContain('内容一致 990 项')
  expect(view.get('.metrics').text()).toContain('4.0 KB')
  expect(api.runNow).not.toHaveBeenCalled()
  expect(button(view, '手动执行').attributes('disabled')).toBeUndefined()
  await view.get('input[aria-label="规则名称"]').setValue('未保存')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  expect(button(view, '只读试运行').attributes('disabled')).toBeDefined()
})

it('prevents manual execution for a preview requiring review', async () => {
  api.dryRun.mockResolvedValueOnce({ success: true, preview: { ...preview, executable: false, summary: '同名项缺少可信证据，请核对' } })
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  expect(view.text()).toContain('同名项缺少可信证据')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  expect(api.runNow).not.toHaveBeenCalled()
})

it('distinguishes backup upload estimates from content verification downloads', async () => {
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), action: { kind: 'backup', planId: 'plan-b', planVersion: 2 } }] })
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  expect(view.get('.metrics').text()).toContain('待写入文件')
  expect(view.get('.metrics').text()).toContain('新增上传量')
  expect(view.get('.metrics').text()).not.toContain('迁移流量')
  expect(view.text()).toContain('不包含完成备份前回读校验产生的下载流量')
  await button(view, '手动执行').trigger('click')
  expect(view.get('.run-confirmation').text()).toContain('不含回读校验下载')
})

it('requires concrete confirmation and submits a version-checked manual run only once', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  await button(view, '手动执行').trigger('click')
  expect(api.runNow).not.toHaveBeenCalled()
  expect(view.get('.run-confirmation').text()).toContain('规则 v4')
  expect(view.get('.run-confirmation').text()).toContain('待写入文件 10 个')
  const late = deferred<unknown>(); api.runNow.mockReturnValueOnce(late.promise)
  await button(view, '确认手动执行').trigger('click'); await flushPromises()
  expect(api.runNow).toHaveBeenCalledWith({ id: 'rule-a', expectedVersion: 4 })
  expect(view.get('.run-confirmation .primary').attributes('disabled')).toBeDefined()
  await view.get('.run-confirmation .primary').trigger('click'); expect(api.runNow).toHaveBeenCalledTimes(1)
  late.resolve({ success: true, run: run() }); await flushPromises()
  expect(view.find('.run-confirmation').exists()).toBe(false)
  expect(view.text()).toContain('已提交一次手动执行')
})

it('refuses an obsolete rule version discovered just before dispatch', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  await button(view, '手动执行').trigger('click')
  api.listRules.mockResolvedValueOnce({ success: true, rules: [{ ...rule(), version: 5 }] })
  await button(view, '确认手动执行').trigger('click'); await flushPromises()
  expect(api.runNow).not.toHaveBeenCalled()
  expect(view.text()).toContain('规则版本已变化，本次未提交')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
})

it('handles an atomic server version rejection without retrying or retaining confirmation', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  await button(view, '手动执行').trigger('click')
  api.runNow.mockResolvedValueOnce({ success: false, error: '规则已更新，请刷新后重试', code: 'RULE_VERSION' })
  await button(view, '确认手动执行').trigger('click'); await flushPromises()
  expect(api.runNow).toHaveBeenCalledTimes(1)
  expect(view.text()).toContain('读取最新规则并重新试运行')
  expect(view.find('.run-confirmation').exists()).toBe(false)
})

it('clears a lost dispatch response and reads history instead of blindly resending', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  await button(view, '手动执行').trigger('click')
  api.runNow.mockRejectedValueOnce(new Error('提交响应丢失，请核对历史'))
  api.listRuns.mockResolvedValueOnce({ success: true, runs: [{ ...run(), status: 'attention', summary: '提交结果待核对' }], total: 1, page: 1, pageSize: 25 })
  await button(view, '确认手动执行').trigger('click'); await flushPromises()
  expect(api.runNow).toHaveBeenCalledTimes(1)
  expect(view.text()).toContain('提交结果待核对')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
})

it('toggles enabled state with the saved version and makes no new task', async () => {
  const view = await render()
  await button(view, '暂停规则').trigger('click'); await flushPromises()
  expect(api.setEnabled).toHaveBeenCalledWith({ id: 'rule-a', expectedVersion: 4, enabled: false })
  expect(view.text()).toContain('规则已暂停，停止创建新任务')
  expect(button(view, '启用规则').exists()).toBe(true)
  expect(api.runNow).not.toHaveBeenCalled()
})

it('allows read-only previews of a paused manual rule but requires enabling before any execution', async () => {
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false, trigger: { kind: 'manual' } }] })
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  expect(api.dryRun).toHaveBeenCalledWith('rule-a')
  expect(view.text()).toContain('执行前请先启用规则')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  await button(view, '手动执行').trigger('click')
  expect(view.find('.run-confirmation').exists()).toBe(false)
  expect(api.runNow).not.toHaveBeenCalled()
  await button(view, '启用规则').trigger('click'); await flushPromises()
  expect(api.setEnabled).toHaveBeenCalledWith({ id: 'rule-a', expectedVersion: 4, enabled: true })
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  expect(button(view, '手动执行').attributes('disabled')).toBeUndefined()
})

it('paginates bounded history and links the exact task back to automation rules', async () => {
  api.listRuns.mockImplementation(input => Promise.resolve({ success: true, runs: [run(`run-page-${input.page}`)], total: 61, page: input.page, pageSize: input.pageSize }))
  const view = await render()
  await button(view, '下一页记录').trigger('click'); await flushPromises()
  expect(api.listRuns).toHaveBeenLastCalledWith({ ruleId: 'rule-a', page: 2, pageSize: 25 })
  expect(view.text()).toContain('第 2 / 3 页')
  await button(view, '查看任务').trigger('click')
  expect(navigation.push).toHaveBeenCalledWith({ path: '/tasks', query: { taskId: 'task-a', from: 'automation-rules' } })
})

it('ignores a late preview and history response from a previously selected rule', async () => {
  const view = await render(), latePreview = deferred<unknown>(), lateHistory = deferred<unknown>()
  api.dryRun.mockReturnValueOnce(latePreview.promise)
  api.listRuns.mockReturnValueOnce(lateHistory.promise)
  await button(view, '只读试运行').trigger('click')
  await button(view, '刷新历史').trigger('click')
  api.listRuns.mockResolvedValueOnce({ success: true, runs: [{ ...run('rule-b-run'), ruleId: 'rule-b', summary: '第二条规则的历史' }], total: 1, page: 1, pageSize: 25 })
  await view.findAll('.rule-item')[1].trigger('click'); await flushPromises()
  latePreview.resolve({ success: true, preview: { ...preview, summary: '过期的第一条预演' } })
  lateHistory.resolve({ success: true, runs: [run()], total: 1, page: 1, pageSize: 25 }); await flushPromises()
  expect(view.text()).not.toContain('过期的第一条预演')
  expect(view.text()).not.toContain('已核对并完成 10 个文件')
  expect(view.text()).toContain('第二条规则的历史')
})

it('requires delete confirmation and retains a rule when linked-rule removal is rejected', async () => {
  const view = await render()
  await button(view, '删除规则').trigger('click'); expect(api.removeRule).not.toHaveBeenCalled()
  api.removeRule.mockResolvedValueOnce({ success: false, error: '其他规则引用了此规则，请先修改关联触发器' })
  await button(view, '确认删除规则').trigger('click'); await flushPromises()
  expect(api.removeRule).toHaveBeenCalledWith('rule-a')
  expect(view.text()).toContain('其他规则引用了此规则')
  expect(view.findAll('.rule-item')).toHaveLength(2)
  await button(view, '确认删除规则').trigger('click'); await flushPromises()
  expect(view.findAll('.rule-item')).toHaveLength(1)
  expect(view.text()).toContain('规则已删除')
})

it('shows independent rule/action read failures and allows a retry', async () => {
  api.listRules.mockRejectedValueOnce(new Error('规则读取失败'))
  api.listActions.mockResolvedValueOnce({ success: false, error: '计划读取失败' })
  const view = await render()
  expect(view.text()).toContain('规则读取失败'); expect(view.text()).toContain('计划读取失败')
  await button(view, '重试').trigger('click'); await flushPromises()
  expect(view.findAll('.rule-item')).toHaveLength(2)
  expect(view.text()).not.toContain('规则读取失败')
})

it('preserves a new-rule draft when the initial saved-rule listing arrives later', async () => {
  const late = deferred<unknown>(); api.listRules.mockReturnValueOnce(late.promise)
  wrapper = mount(AutomationRules); const view = wrapper
  await button(view, '新建').trigger('click')
  await view.get('input[aria-label="规则名称"]').setValue('正在填写的新规则')
  late.resolve({ success: true, rules: [rule()] }); await flushPromises()
  expect(view.get('input[aria-label="规则名称"]').element).toHaveProperty('value', '正在填写的新规则')
  expect(view.get('.configuration').text()).toContain('新建规则')
})

it('refreshes history while mounted and cancels its timer on unmount', async () => {
  vi.useFakeTimers()
  const view = await render(); const calls = api.listRuns.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000); await flushPromises()
  expect(api.listRuns).toHaveBeenCalledTimes(calls + 1)
  view.unmount(); wrapper = undefined
  await vi.advanceTimersByTimeAsync(15000)
  expect(api.listRuns).toHaveBeenCalledTimes(calls + 1)
})

it('reflects an automatic pause and last result during history refresh without replacing an edited draft', async () => {
  const view = await render()
  await view.get('input[aria-label="规则名称"]').setValue('继续编辑中的规则')
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false, error: '关联任务未全部完成，请核对任务记录', lastSuccessAt: now }] })
  await button(view, '刷新历史').trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="规则名称"]').element).toHaveProperty('value', '继续编辑中的规则')
  expect(view.text()).toContain('关联任务未全部完成')
  expect(view.text()).toContain('规则已暂停')
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  expect(api.saveRule).not.toHaveBeenCalled()
})

it('invalidates an open manual confirmation when history polling observes a newer configuration version', async () => {
  const view = await render()
  await button(view, '只读试运行').trigger('click'); await flushPromises()
  await button(view, '手动执行').trigger('click')
  expect(view.find('.run-confirmation').exists()).toBe(true)
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), version: 5, name: '其他窗口的新版本' }] })
  await button(view, '刷新历史').trigger('click'); await flushPromises()
  expect(view.find('.run-confirmation').exists()).toBe(false)
  expect(button(view, '手动执行').attributes('disabled')).toBeDefined()
  expect(view.get('input[aria-label="规则名称"]').element).toHaveProperty('value', '项目自动归档')
  expect(view.text()).toContain('读取最新规则并重新试运行')
  expect(api.runNow).not.toHaveBeenCalled()
})

it('background: saving a name draft after an automatic pause does not silently enable the rule', async () => {
  const view = await render(); await view.get('input[aria-label="规则名称"]').setValue('只修改名称')
  const paused = { ...rule(), enabled: false, error: '账号失效，规则已暂停', updatedAt: now + 10 }
  api.listRules.mockResolvedValue({ success: true, rules: [paused] })
  await button(view, '刷新历史').trigger('click'); await flushPromises()
  await view.get('form.rule-form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ name: '只修改名称', expectedVersion: 4, enabled: false }))
})

it('background: an older all-rules response cannot undo an automatic pause observed by history', async () => {
  const view = await render(), late = deferred<unknown>()
  api.listRules.mockReturnValueOnce(late.promise); await button(view, '刷新列表').trigger('click')
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false, error: '账号失效，规则已暂停', updatedAt: now + 10 }] })
  await button(view, '刷新历史').trigger('click'); await flushPromises()
  late.resolve({ success: true, rules: [rule()] }); await flushPromises()
  expect(view.get('.configuration').text()).toContain('账号失效，规则已暂停')
  expect(button(view, '启用规则').exists()).toBe(true)
  await view.get('.rule-item').trigger('click'); await flushPromises()
  expect(button(view, '启用规则').exists()).toBe(true)
})

it('background: a same-version automatic pause found before dispatch blocks the mutation', async () => {
  const view = await render(); await button(view, '只读试运行').trigger('click'); await flushPromises(); await button(view, '手动执行').trigger('click')
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false, error: '账号失效，规则已暂停', updatedAt: now + 10 }] })
  await button(view, '确认手动执行').trigger('click'); await flushPromises()
  expect(api.runNow).not.toHaveBeenCalled(); expect(view.text()).toContain('规则已暂停'); expect(view.find('.run-confirmation').exists()).toBe(false)
})

it('background: leaving during final dispatch validation never sends a task after the page is gone', async () => {
  const view = await render(); await button(view, '只读试运行').trigger('click'); await flushPromises(); await button(view, '手动执行').trigger('click')
  const late = deferred<unknown>(); api.listRules.mockReturnValueOnce(late.promise)
  await button(view, '确认手动执行').trigger('click'); view.unmount(); wrapper = undefined
  late.resolve({ success: true, rules: [rule()] }); await flushPromises()
  expect(api.runNow).not.toHaveBeenCalled(); expect(api.setEnabled).not.toHaveBeenCalled(); expect(navigation.push).not.toHaveBeenCalled()
})

it('background: history refresh preserves the users explicit decision to enable a paused rule', async () => {
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false }] })
  const view = await render(); await view.get('input[aria-label="保存后启用规则"]').setValue(true)
  await view.get('input[aria-label="规则名称"]').setValue('明确启用后的名称')
  api.listRules.mockResolvedValue({ success: true, rules: [{ ...rule(), enabled: false, updatedAt: now + 10 }] })
  await button(view, '刷新历史').trigger('click'); await flushPromises()
  expect(view.get('input[aria-label="保存后启用规则"]').element).toHaveProperty('checked', true)
  await view.get('form.rule-form').trigger('submit'); await flushPromises()
  expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, name: '明确启用后的名称' }))
})
