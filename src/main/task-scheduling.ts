import { getDb, getSetting, type DbTask } from './db'
import { readTaskSchedule, writeTaskSchedule } from './task-scheduling-store'
import { getTransferRuntimeSettings, isInTransferWindow } from './transfer-runtime'
import type { TaskScheduleInfo } from '../shared/task-scheduling'

const TRANSFERS = new Set(['upload', 'download', 'cloud_transfer', 'batch_transfer', 'transfer', 'planned_transfer', 'subscription_sync', 'file_backup', 'file_restore', 'file_backup_prune'])

export class TaskWindowClosedError extends Error {
  constructor() { super('传输时段已结束，已保存进度并等待下一时段'); this.name = 'TaskWindowClosedError' }
}

export function taskScheduleInfo(task: Pick<DbTask, 'id' | 'task_type' | 'status'>, date = new Date()): TaskScheduleInfo {
  const schedule = readTaskSchedule(getDb(), task.id)
  const window = schedule.window ?? (TRANSFERS.has(task.task_type) ? getTransferRuntimeSettings().scheduledWindow : '')
  if (schedule.notBefore !== null && schedule.notBefore > date.getTime()) {
    return { ...schedule, waitReason: '等待指定开始时间', nextEligibleAt: schedule.notBefore }
  }
  if (window && !isInTransferWindow(window, date)) {
    const match = window.match(/^(\d{1,2}):(\d{2})-/)
    const next = new Date(date)
    if (match) { next.setHours(Number(match[1]), Number(match[2]), 0, 0); if (next <= date) next.setDate(next.getDate() + 1) }
    return { ...schedule, waitReason: `等待传输时段 ${window}`, nextEligibleAt: match ? next.getTime() : undefined }
  }
  return schedule
}

export function assertTaskOperationSchedule(task: Pick<DbTask, 'id' | 'task_type' | 'status'>): void {
  if (getSetting('transferPauseAtWindowEnd')?.value !== 'true') return
  if (taskScheduleInfo(task).waitReason) throw new TaskWindowClosedError()
}

export function saveTaskSchedule(taskId: string, value: unknown): TaskScheduleInfo {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 200) throw new Error('任务标识无效')
  return writeTaskSchedule(getDb(), taskId, value)
}
