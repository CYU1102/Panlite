export type TaskPriority = 'low' | 'normal' | 'high'
export interface TaskSchedule {
  priority: TaskPriority
  /** null inherits the global window; empty string explicitly removes it. */
  window: string | null
  notBefore: number | null
}
export interface TaskScheduleInfo extends TaskSchedule {
  waitReason?: string
  nextEligibleAt?: number
}
export const DEFAULT_TASK_SCHEDULE: TaskSchedule = { priority: 'normal', window: null, notBefore: null }
export const TASK_SCHEDULE_CHANNEL = 'task:schedule'

export function normalizeTaskSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务调度设置无效')
  const input = value as Record<string, unknown>
  if (!['low', 'normal', 'high'].includes(String(input.priority))) throw new Error('任务优先级无效')
  const window = input.window
  if (window !== null && (typeof window !== 'string' || !isValidTransferWindow(window))) throw new Error('传输时段应为 HH:MM-HH:MM')
  const notBefore = input.notBefore
  if (notBefore !== null && (typeof notBefore !== 'number' || !Number.isSafeInteger(notBefore) || notBefore < 0 || notBefore > 8.64e15)) throw new Error('任务开始时间无效')
  return { priority: input.priority as TaskPriority, window, notBefore }
}

export function isValidTransferWindow(value: string): boolean {
  if (!value) return true
  const parts = value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
  return Boolean(parts && Number(parts[1]) < 24 && Number(parts[2]) < 60 && Number(parts[3]) < 24 && Number(parts[4]) < 60)
}
