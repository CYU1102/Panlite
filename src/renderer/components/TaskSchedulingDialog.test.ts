// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Task } from '@shared/types'

const api = vi.hoisted(() => ({ setTaskSchedule: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import TaskSchedulingDialog from './TaskSchedulingDialog.vue'

const task: Task = { id: 'task-a', accountId: 'account', platform: 'quark', taskType: 'download', title: '夜间下载', payload: {}, status: 'pending', progress: 0, retryCount: 0, createdAt: 1, updatedAt: 1 }
let wrapper: VueWrapper | undefined
beforeEach(() => { vi.resetAllMocks(); api.setTaskSchedule.mockResolvedValue({ success: true }) })
afterEach(() => { wrapper?.unmount(); wrapper = undefined })
function render(value: Task = task) {
  wrapper = mount(TaskSchedulingDialog, { props: { task: value }, global: { stubs: {
    ElDialog: { template: '<div><slot /></div>' },
    ElButton: { props: ['nativeType', 'loading'], template: '<button :type="nativeType || \'button\'" :disabled="loading"><slot /></button>' },
  } } })
  return wrapper
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

it('saves priority, a custom overnight window and a local not-before date as one concrete schedule', async () => {
  const view = render()
  await view.get('select[aria-label="任务优先级"]').setValue('high')
  await view.get('select[aria-label="任务时段模式"]').setValue('custom')
  await view.get('input[aria-label="任务传输时段"]').setValue('23:00-06:00')
  await view.get('input[aria-label="最早开始时间"]').setValue('2026-09-10T23:30')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.setTaskSchedule).toHaveBeenCalledExactlyOnceWith('task-a', { priority: 'high', window: '23:00-06:00', notBefore: new Date('2026-09-10T23:30').getTime() })
  expect(view.emitted('changed')).toHaveLength(1); expect(view.emitted('close')).toHaveLength(1)
})

it('restores saved values and distinguishes an inherited window from explicit unrestricted timing', async () => {
  const notBefore = new Date('2026-09-12T02:45').getTime()
  const view = render({ ...task, schedule: { priority: 'low', window: '02:00-08:00', notBefore } })
  expect(view.get('select[aria-label="任务优先级"]').element).toHaveProperty('value', 'low')
  expect(view.get('input[aria-label="任务传输时段"]').element).toHaveProperty('value', '02:00-08:00')
  expect(view.get('input[aria-label="最早开始时间"]').element).toHaveProperty('value', '2026-09-12T02:45')
  await view.get('select[aria-label="任务时段模式"]').setValue('any')
  await view.get('input[aria-label="最早开始时间"]').setValue('')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.setTaskSchedule).toHaveBeenLastCalledWith('task-a', { priority: 'low', window: '', notBefore: null })
  await view.setProps({ task: { ...task, id: 'task-b' } })
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.setTaskSchedule).toHaveBeenLastCalledWith('task-b', { priority: 'normal', window: null, notBefore: null })
})

it('keeps the draft on validation or save failure and prevents duplicate submissions while saving', async () => {
  const view = render()
  await view.get('select[aria-label="任务时段模式"]').setValue('custom')
  await view.get('input[aria-label="任务传输时段"]').setValue('25:00-08:00')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain('HH:MM-HH:MM'); expect(api.setTaskSchedule).not.toHaveBeenCalled()
  await view.get('input[aria-label="任务传输时段"]').setValue('02:00-08:00')
  const request = deferred<unknown>(); api.setTaskSchedule.mockReturnValueOnce(request.promise)
  await view.get('form').trigger('submit'); await view.get('form').trigger('submit')
  expect(api.setTaskSchedule).toHaveBeenCalledTimes(1)
  request.resolve({ success: false, error: '调度写入失败，请重试' }); await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain('调度写入失败')
  expect(view.get('input[aria-label="任务传输时段"]').element).toHaveProperty('value', '02:00-08:00')
  expect(view.emitted('changed')).toBeUndefined(); expect(view.emitted('close')).toBeUndefined()
})

it('ignores late responses belonging to a different task and keeps the current task editable', async () => {
  const view = render(), request = deferred<unknown>(); api.setTaskSchedule.mockReturnValueOnce(request.promise)
  await view.get('form').trigger('submit')
  await view.setProps({ task: { ...task, id: 'task-b', title: '另一项下载', schedule: { priority: 'high', window: '', notBefore: null } } })
  request.resolve({ success: false, error: '旧任务失败' }); await flushPromises()
  expect(view.text()).not.toContain('旧任务失败'); expect(view.text()).toContain('另一项下载')
  await view.get('form').trigger('submit'); await flushPromises()
  expect(api.setTaskSchedule).toHaveBeenLastCalledWith('task-b', { priority: 'high', window: '', notBefore: null })
  expect(view.emitted('changed')).toHaveLength(1)
})
