import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DriveAdapter } from '../adapters/base'
import { fatal } from '../adapters/errors'
import { getDb, type DbTask } from './db'

type OperationOwner = Pick<DbTask, 'id' | 'execution_token'>

interface OperationRecord {
  status: 'prepared' | 'started' | 'succeeded'
  result_json: string | null
  execution_token: string
}

interface OperationContext {
  task: OperationOwner
  key: string
}

const operationContexts = new AsyncLocalStorage<OperationContext[]>()

/** A parent operation admitted before the deadline must finish and save its receipt. */
export function isWithinTaskOperation(task: OperationOwner): boolean {
  return Boolean(operationContexts.getStore()?.some(context => context.task.id === task.id && context.task.execution_token === task.execution_token))
}

/** Fence every nested operation immediately before a provider mutation. */
export async function dispatchTaskMutation<T>(execute: () => Promise<T>): Promise<T> {
  const contexts = operationContexts.getStore() || []
  const database = getDb()
  database.transaction(() => {
    for (const { task, key } of contexts) {
      const changed = database.prepare(`UPDATE task_operations SET status = 'started', updated_at = ?
        WHERE task_id = ? AND operation_key = ? AND execution_token = ? AND status IN ('prepared', 'started')
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'running' AND execution_token = ?)`)
        .run(Date.now(), task.id, key, task.execution_token, task.id, task.execution_token)
      if (changed.changes !== 1) throw fatal('任务执行权已转移，无法执行远端操作', { code: 'TASK_SUPERSEDED' })
    }
  }).immediate()
  return execute()
}

const MUTATIONS = new Set(['mkdir', 'rename', 'move', 'delete', 'copy', 'createShare', 'saveSharedFiles', 'upload'])

/** Keep provider implementations and their `this` binding intact. */
export function guardTaskAdapterMutations(adapter: DriveAdapter): DriveAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function') return member
      if (!MUTATIONS.has(String(property))) return member.bind(target)
      return (...args: unknown[]) => dispatchTaskMutation(async () => Reflect.apply(member, target, args))
    },
  })
}

/** Stable across attempts; scoped to a task so a new user action remains distinct. */
export function taskOperationKey(kind: string, item: string): string {
  return createHash('sha256').update(JSON.stringify([kind, item])).digest('hex')
}

export function uncertainTaskOperation(kind: string): Error {
  return fatal(`远端操作结果待核对（${kind}）：为避免重复执行，已停止重发。请在网盘核对结果；确认需要重新执行后新建任务。`, {
    code: 'REMOTE_RESULT_UNCERTAIN',
    action: kind,
  })
}

/**
 * Prepare before work, fence intent BEFORE remote mutations, then save results.
 * A recovered/in-flight intent is never blindly repeated: providers without an
 * idempotency API cannot prove that a timed-out request did not commit remotely.
 * Existing adapter signatures and task payloads are deliberately unchanged.
 */
export async function runTaskOperation<T>(
  task: OperationOwner,
  kind: string,
  item: string,
  execute: () => Promise<T>,
): Promise<T> {
  const database = getDb()
  const key = taskOperationKey(kind, item)
  const token = task.execution_token
  const claim = database.transaction(() => {
    const owner = database.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'running' AND execution_token = ?")
      .get(task.id, token)
    if (!token || !owner) throw fatal('任务执行权已转移，无法执行远端操作', { code: 'TASK_SUPERSEDED' })
    const previous = database.prepare('SELECT status, result_json, execution_token FROM task_operations WHERE task_id = ? AND operation_key = ?')
      .get(task.id, key) as OperationRecord | undefined
    if (previous?.status === 'prepared' && previous.execution_token !== token) {
      // No mutation was dispatched. The old owner cannot cross the dispatch
      // fence after this transaction, so recovery can safely prepare again.
      database.prepare('DELETE FROM task_operations WHERE task_id = ? AND operation_key = ?').run(task.id, key)
    } else if (previous) return previous
    const timestamp = Date.now()
    database.prepare(`INSERT INTO task_operations
      (task_id, operation_key, execution_token, status, created_at, updated_at)
      VALUES (?, ?, ?, 'prepared', ?, ?)`).run(task.id, key, token, timestamp, timestamp)
    return undefined
  }).immediate()

  if (claim?.status === 'succeeded') return JSON.parse(claim.result_json!) as T
  if (claim) throw uncertainTaskOperation(kind)

  // AsyncLocalStorage isolates parallel files while retaining parent intents
  // for nested directory operations. A read/download failure is safe to retry;
  // once any mutation was sent, error text alone cannot prove non-completion.
  let result: T
  try {
    result = await operationContexts.run([...(operationContexts.getStore() || []), { task, key }], execute)
  } catch (error) {
    database.prepare("DELETE FROM task_operations WHERE task_id = ? AND operation_key = ? AND execution_token = ? AND status = 'prepared'")
      .run(task.id, key, token)
    throw error
  }
  // A late result is evidence belonging to the original operation only. It
  // cannot change task state/progress or overwrite another attempt's result.
  const saved = database.prepare(`UPDATE task_operations
    SET status = 'succeeded', result_json = ?, updated_at = ?
    WHERE task_id = ? AND operation_key = ? AND execution_token = ? AND status IN ('prepared', 'started')`)
    .run(JSON.stringify(result ?? null), Date.now(), task.id, key, token)
  if (saved.changes !== 1) throw uncertainTaskOperation(kind)
  return result
}
