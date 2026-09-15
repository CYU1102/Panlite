import type Database from 'better-sqlite3'
import { DEFAULT_TASK_SCHEDULE, normalizeTaskSchedule, type TaskSchedule } from '../shared/task-scheduling'

export function initializeTaskSchedulingSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_schedules (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    priority TEXT NOT NULL, transfer_window TEXT, not_before INTEGER, updated_at INTEGER NOT NULL
  )`)
}

export function readTaskSchedule(db: Database.Database, taskId: string): TaskSchedule {
  const row = db.prepare('SELECT priority, transfer_window, not_before FROM task_schedules WHERE task_id = ?').get(taskId) as
    { priority: string; transfer_window: string | null; not_before: number | null } | undefined
  return row ? normalizeTaskSchedule({ priority: row.priority, window: row.transfer_window, notBefore: row.not_before }) : { ...DEFAULT_TASK_SCHEDULE }
}

export function writeTaskSchedule(db: Database.Database, taskId: string, value: unknown): TaskSchedule {
  const schedule = normalizeTaskSchedule(value)
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined
  if (!task || !['pending', 'paused', 'running'].includes(task.status)) throw new Error('只能调整未完成任务的调度')
  db.prepare(`INSERT INTO task_schedules(task_id, priority, transfer_window, not_before, updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET priority=excluded.priority,
    transfer_window=excluded.transfer_window, not_before=excluded.not_before, updated_at=excluded.updated_at`)
    .run(taskId, schedule.priority, schedule.window, schedule.notBefore, Date.now())
  return schedule
}
