import type { TaskSchedule } from '../shared/task-scheduling'

export interface AdmissionTask { id: string; platform: string; status: string; createdAt: number }
export interface AdmissionDecision { eligible: boolean; schedule: TaskSchedule }
interface AdmissionOptions<T extends AdmissionTask> {
  getTask(id: string): T | undefined
  decide(task: T): AdmissionDecision
  capacity(platform: string): number
  run(task: T): Promise<void>
  onError(error: unknown): void
  now?: () => number
}

/** Only eligible tasks occupy a worker. A task's original waiting time provides aging. */
export class TaskAdmissionQueue<T extends AdmissionTask> {
  private readonly waiting = new Set<string>()
  private readonly running = new Map<string, string>()
  private readonly retryAfter = new Map<string, number>()
  private readonly platforms = new Set<string>()
  private scheduled = false
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  constructor(private readonly options: AdmissionOptions<T>) {}

  enqueue(id: string, delayMs = 0): void {
    if (this.disposed) return
    this.waiting.add(id)
    if (delayMs > 0) this.retryAfter.set(id, this.now() + delayMs)
    this.refresh()
  }
  remove(id: string): void { this.waiting.delete(id); this.retryAfter.delete(id); this.refresh() }
  refresh(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; if (!this.disposed) this.drain() })
  }
  private now(): number { return (this.options.now ?? Date.now)() }
  private drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const now = this.now()
    const candidates: Array<{ task: T; rank: number }> = []
    for (const id of this.waiting) {
      if (this.running.has(id)) continue
      try {
        const task = this.options.getTask(id)
        if (!task || task.status !== 'pending') { this.waiting.delete(id); this.retryAfter.delete(id); continue }
        this.platforms.add(task.platform)
        if ((this.retryAfter.get(id) ?? 0) > now) continue
        const decision = this.options.decide(task)
        if (!decision.eligible) continue
        const priority = { low: -10, normal: 0, high: 10 }[decision.schedule.priority]
        const aging = Math.floor(Math.max(0, now - task.createdAt) / 60_000)
        candidates.push({ task, rank: priority + aging })
      } catch (error) { this.options.onError(error) }
    }
    candidates.sort((a, b) => b.rank - a.rank || a.task.createdAt - b.task.createdAt || a.task.id.localeCompare(b.task.id))
    for (const { task } of candidates) {
      const active = [...this.running.values()].filter(platform => platform === task.platform).length
      if (active >= this.options.capacity(task.platform)) continue
      this.waiting.delete(task.id)
      this.retryAfter.delete(task.id)
      this.running.set(task.id, task.platform)
      Promise.resolve().then(() => this.options.run(task)).catch(error => this.options.onError(error)).finally(() => {
        this.running.delete(task.id)
        this.refresh()
      })
    }
    if (this.waiting.size) {
      this.timer = setTimeout(() => { this.timer = undefined; this.refresh() }, 1000)
      this.timer.unref?.()
    }
  }
  status(): Record<string, { pending: number; running: number; size: number }> {
    const output: Record<string, { pending: number; running: number; size: number }> = {}
    for (const platform of this.platforms) output[platform] = { pending: 0, running: 0, size: 0 }
    for (const platform of this.running.values()) {
      output[platform] ??= { pending: 0, running: 0, size: 0 }
      output[platform].running++; output[platform].size++
    }
    for (const id of this.waiting) {
      if (this.running.has(id)) continue
      const task = this.options.getTask(id)
      if (!task || task.status !== 'pending') continue
      output[task.platform] ??= { pending: 0, running: 0, size: 0 }
      output[task.platform].pending++; output[task.platform].size++
    }
    return output
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.waiting.clear(); this.retryAfter.clear()
  }
}
