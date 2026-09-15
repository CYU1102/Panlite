// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Task } from '@shared/types'
import { createMemoryHistory, createRouter } from 'vue-router'

const api = vi.hoisted(() => ({ listTasks: vi.fn(), retryTask: vi.fn(), pauseTask: vi.fn(), resumeTask: vi.fn(), cancelTask: vi.fn(),
  onTaskUpdated: vi.fn(), getTaskLogs: vi.fn(), remove: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, error: api.error } }))
import TaskLog from './TaskLog.vue'

let wrapper: VueWrapper | undefined
let listener: () => void
const rows = [
  { id: 'failed', title: '上传报告', status: 'failed', taskType: 'upload' },
  { id: 'running', title: '下载资料', status: 'running', taskType: 'download' },
  { id: 'paused', title: '等待传输', status: 'paused', taskType: 'upload' },
].map(row => ({ ...row, platform: 'quark', accountId: 'account', payload: {}, retryCount: 0, progress: 10, createdAt: Date.now(), updatedAt: Date.now() })) as Task[]

beforeEach(() => {
  vi.clearAllMocks()
  api.listTasks.mockResolvedValue({ success: true, tasks: rows })
  api.pauseTask.mockResolvedValue({ success: true })
  api.resumeTask.mockResolvedValue({ success: true })
  api.onTaskUpdated.mockImplementation((callback: () => void) => { listener = callback; return api.remove })
  api.getTaskLogs.mockResolvedValue({ success: true, logs: [] })
})

afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function render() {
  wrapper = mount(TaskLog, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, ElDialog: true } } })
  await flushPromises()
  return wrapper
}

it('filters status and task type using the visible controls', async () => {
  const view = await render()
  expect(view.findAll('.task-row')).toHaveLength(3)
  const failed = view.findAll('.filter-chip').find(button => button.text().startsWith('失败'))!
  await failed.trigger('click')
  expect(view.findAll('.task-row')).toHaveLength(1)
  expect(view.find('.task-row').text()).toContain('上传报告')
  await view.findAll('.filter-chip').find(button => button.text() === '下载')!.trigger('click')
  expect(view.findAll('.task-row')).toHaveLength(0)
})

it('locates the exact task linked from a migration plan and handles a deleted record', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks', component: TaskLog }] })
  await router.push('/tasks?taskId=running&from=transfer-plans')
  await router.isReady()
  wrapper = mount(TaskLog, { global: { plugins: [router], stubs: { ElDialog: true } } })
  await flushPromises()
  expect(wrapper.findAll('.task-row')).toHaveLength(1)
  expect(wrapper.get('.task-row').text()).toContain('下载资料')
  await router.push('/tasks?taskId=removed&from=transfer-plans')
  await flushPromises()
  expect(wrapper.findAll('.task-row')).toHaveLength(0)
  expect(wrapper.get('[role="status"]').text()).toContain('该任务记录不存在或已被删除')
})

it('shows retry errors and sends pause/resume to the selected task only', async () => {
  api.retryTask.mockResolvedValue({ success: false, error: '远端操作结果待核对' })
  const view = await render()
  await view.get('button[title="重新执行此任务"]').trigger('click')
  await flushPromises()
  expect(api.retryTask).toHaveBeenCalledWith('failed')
  expect(api.error).toHaveBeenCalledWith('远端操作结果待核对')
  await view.get('button[title="暂停此任务"]').trigger('click')
  await flushPromises()
  expect(api.pauseTask).toHaveBeenCalledWith('running')
  await view.get('button[title="恢复此任务"]').trigger('click')
  await flushPromises()
  expect(api.resumeTask).toHaveBeenCalledWith('paused')
})

it('refreshes on IPC events and releases the listener when leaving the page', async () => {
  await render()
  const count = api.listTasks.mock.calls.length
  listener()
  await flushPromises()
  expect(api.listTasks).toHaveBeenCalledTimes(count + 1)
  wrapper!.unmount()
  wrapper = undefined
  expect(api.remove).toHaveBeenCalledTimes(1)
})

it('shows cancellation rejection instead of reporting success', async () => {
  const view = await render()
  api.cancelTask.mockResolvedValueOnce({ success: false, error: 'fixture cancellation denied' })
  await (view.vm as unknown as { onCancel: (task: Task) => Promise<void> }).onCancel(rows[1])
  expect(api.error).toHaveBeenCalledWith('fixture cancellation denied')
  expect(api.success).not.toHaveBeenCalledWith('任务已取消')
})

it('clears previous logs when opening a task whose logs cannot be loaded', async () => {
  const view = await render()
  const vm = view.vm as unknown as { onViewLog: (task: Task) => Promise<void>; currentLogs: unknown[] }
  api.getTaskLogs.mockResolvedValueOnce({ success: true, logs: [{ message: 'previous task' }] })
  await vm.onViewLog(rows[0]); expect(vm.currentLogs).toHaveLength(1)
  api.getTaskLogs.mockResolvedValueOnce({ success: false, error: 'fixture log failure' })
  await vm.onViewLog(rows[1]); expect(vm.currentLogs).toEqual([]); expect(api.error).toHaveBeenCalledWith('fixture log failure')
})
