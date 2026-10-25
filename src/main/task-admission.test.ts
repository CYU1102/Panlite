import { afterEach, expect, it, vi } from 'vitest'
import { TaskAdmissionQueue, type AdmissionTask } from './task-admission'
import { DEFAULT_TASK_SCHEDULE } from '../shared/task-scheduling'

const queues: Array<TaskAdmissionQueue<AdmissionTask>> = []
afterEach(() => { queues.splice(0).forEach(queue => queue.dispose()); vi.useRealTimers() })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function harness() {
  const tasks = new Map<string, AdmissionTask>()
  const allowed = new Set<string>()
  const high = new Set<string>()
  const started: string[] = []
  const completions = new Map<string, () => void>()
  const queue = new TaskAdmissionQueue<AdmissionTask>({
    getTask: id => tasks.get(id), capacity: () => 1,
    decide: task => ({ eligible: allowed.has(task.id), schedule: { ...DEFAULT_TASK_SCHEDULE, priority: high.has(task.id) ? 'high' : 'normal' } }),
    run: task => { task.status = 'running'; started.push(task.id); return new Promise(resolve => completions.set(task.id, () => { task.status = 'success'; resolve() })) },
    onError: error => { throw error },
  })
  queues.push(queue)
  const add = (id: string, age = 0) => { tasks.set(id, { id, platform: 'quark', status: 'pending', createdAt: Date.now() - age }); queue.enqueue(id) }
  return { queue, tasks, allowed, high, started, completions, add }
}

it('keeps work outside its window pending without blocking an eligible task on the same platform', async () => {
  const h = harness(); h.add('night'); h.add('rename'); h.allowed.add('rename'); await flush()
  expect(h.started).toEqual(['rename'])
  expect(h.tasks.get('night')?.status).toBe('pending')
  expect(h.queue.status().quark).toEqual({ pending: 1, running: 1, size: 2 })
  h.completions.get('rename')!(); h.allowed.add('night'); h.queue.refresh(); await flush()
  expect(h.started).toEqual(['rename', 'night'])
})

it('applies changed priorities before admission, deduplicates delivery, and ages long waiting tasks', async () => {
  const h = harness(); h.add('normal'); h.add('high'); h.high.add('high'); h.allowed.add('high'); h.allowed.add('normal')
  h.queue.enqueue('high'); await flush(); expect(h.started).toEqual(['high'])
  h.add('old', 11 * 60_000); h.allowed.add('old'); h.add('new-high'); h.high.add('new-high'); h.allowed.add('new-high')
  h.completions.get('high')!(); await flush(); expect(h.started).toEqual(['high', 'old'])
})

it('does not revive a manually paused task after eligibility changes', async () => {
  const h = harness(); h.add('paused'); await flush(); h.tasks.get('paused')!.status = 'paused'
  h.allowed.add('paused'); h.queue.refresh(); await flush()
  expect(h.started).toEqual([]); expect(h.queue.status().quark.running).toBe(0)
})

it('retains retry delay across unrelated scheduling refreshes and enqueues while the previous worker finishes', async () => {
  vi.useFakeTimers(); const h = harness(); h.add('retry'); h.allowed.add('retry'); await flush()
  h.queue.enqueue('retry', 5000); h.completions.get('retry')!(); h.tasks.get('retry')!.status = 'pending'
  h.queue.refresh(); await flush(); expect(h.started).toEqual(['retry'])
  await vi.advanceTimersByTimeAsync(5000); await flush(); expect(h.started).toEqual(['retry', 'retry'])
})
