import { IPC_CHANNELS } from '../../shared/constants'
import { getAllTasks, getTaskById, getRecentLogs, getLogsByTaskId, deleteTaskById } from '../db'
import { retryTask, cancelTask, pauseTask, resumeTask, refreshTaskScheduling } from '../task-runner'
import { taskScheduleInfo, saveTaskSchedule } from '../task-scheduling'
import { TASK_SCHEDULE_CHANNEL } from '../../shared/task-scheduling'
import type { IpcRegistrar } from './types'

export function registerTasksIpcHandlers(ipcMain: IpcRegistrar): void {
  ipcMain.handle(TASK_SCHEDULE_CHANNEL, async (_event, taskId: string, schedule: unknown) => {
    try {
      const result = saveTaskSchedule(taskId, schedule)
      refreshTaskScheduling()
      return { success: true, schedule: result }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  // ---- Task handlers ----

  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async () => {
    try {
      const tasks = getAllTasks().map((task) => ({
        id: task.id,
        accountId: task.account_id,
        platform: task.platform,
        taskType: task.task_type,
        title: task.title,
        payload: JSON.parse(task.payload || '{}'),
        status: task.status,
        progress: task.progress,
        retryCount: task.retry_count,
        errorMessage: task.error_message || undefined,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        finishedAt: task.finished_at || undefined,
        schedule: taskScheduleInfo(task),
      }))
      return { success: true, tasks }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RETRY, async (_event, taskId: string) => {
    try {
      const ok = retryTask(taskId)
      return ok ? { success: true } : { success: false, error: '任务不存在或无法重试' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, async (_event, taskId: string) => {
    try {
      const ok = cancelTask(taskId)
      return ok ? { success: true } : { success: false, error: '任务不存在或无法取消' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_event, taskId: string) => {
    try {
      return pauseTask(taskId) ? { success: true } : { success: false, error: '任务不存在或无法暂停' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_event, taskId: string) => {
    try {
      return resumeTask(taskId) ? { success: true } : { success: false, error: '任务不存在或无法恢复' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, async (_event, taskId: string) => {
    try {
      const task = getTaskById(taskId)
      if (!task) return { success: false, error: '任务不存在' }
      if (!['success', 'partial_success', 'failed', 'cancelled'].includes(task.status)) {
        return { success: false, error: '只能删除已结束的任务' }
      }
      return deleteTaskById(taskId) ? { success: true } : { success: false, error: '删除失败' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TASK_LOGS, async (_event, taskId: string) => {
    try {
      const logs = (taskId ? getLogsByTaskId(taskId) : getRecentLogs(200)).map((entry) => ({
        id: entry.id,
        level: entry.level,
        module: entry.module || undefined,
        message: entry.message,
        detail: entry.detail || undefined,
        createdAt: entry.created_at,
      }))
      return { success: true, logs }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}
