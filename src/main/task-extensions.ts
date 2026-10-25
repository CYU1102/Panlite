import type { DbTask } from './db'
import type { LogLevel } from '../shared/types'

export interface TaskExtensionContext {
  task: DbTask
  signal: AbortSignal
  assertActive(): void
  operation<T>(kind: string, item: string, execute: () => Promise<T>): Promise<T>
  progress(percent: number, summary?: string): void
  log(level: LogLevel, message: string): void
}
export type TaskExtensionExecutor = (context: TaskExtensionContext) => Promise<{ partial?: boolean; summary?: string } | void>
export type ExtensionTaskType = 'planned_transfer' | 'file_backup' | 'file_restore' | 'file_backup_prune' | 'subscription_sync'
const executors = new Map<ExtensionTaskType, TaskExtensionExecutor>()

/** Extensions use the existing queue, lifecycle, execution token and mutation journal. */
export function registerTaskExtension(type: ExtensionTaskType, execute: TaskExtensionExecutor): () => void {
  if (executors.has(type)) throw new Error(`Task executor already registered: ${type}`)
  executors.set(type, execute)
  return () => { if (executors.get(type) === execute) executors.delete(type) }
}

export function getTaskExtension(type: string): TaskExtensionExecutor | undefined {
  return executors.get(type as ExtensionTaskType)
}
