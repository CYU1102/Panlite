/** Child-process harness: real SQLite/runtime code, no Electron or network. */
import fs from 'node:fs'
import { getDb, getTaskById, initDatabase, insertTask, recoverInterruptedTasks, transitionTaskStatusIfCurrent, updateTaskPayloadIfOwned, updateTaskProgressIfOwned, deleteTaskById, setSetting, getSetting } from '../db'
import { dispatchTaskMutation, runTaskOperation } from '../task-operations'

interface Request {
  requestId: number
  action: string
  id: string
  token?: string
  nextToken?: string
  status?: string
  key?: string
  kind?: string
  hold?: boolean
  readOnly?: boolean
}

const held = new Map<string, () => void>()

initDatabase()
process.send?.({ ready: true })
process.on('message', (request: Request) => {
  void handle(request).then(
    result => process.send?.({ requestId: request.requestId, result }),
    error => process.send?.({ requestId: request.requestId, error: error.message, code: error.code }),
  )
})

async function handle(request: Request): Promise<unknown> {
  const { id, token = 'A' } = request
  switch (request.action) {
    case 'insert':
      insertTask({ id, account_id: 'mock-account', platform: 'quark', task_type: 'upload', title: id,
        payload: '{}', status: request.status || 'pending', progress: 37, retry_count: 0,
        execution_token: request.status === 'running' ? token : null, error_message: null,
        created_at: Date.now(), updated_at: Date.now(), finished_at: null })
      return true
    case 'claim':
      return transitionTaskStatusIfCurrent(id, 'pending', 'running', { expectedExecutionToken: null, executionToken: token })
    case 'read': return getTaskById(id)
    case 'recover': return recoverInterruptedTasks()
    case 'pause':
      return transitionTaskStatusIfCurrent(id, 'running', 'paused', { expectedExecutionToken: token, executionToken: null })
    case 'resume':
      return transitionTaskStatusIfCurrent(id, 'paused', 'pending', { expectedExecutionToken: null, executionToken: null })
    case 'retry':
      return transitionTaskStatusIfCurrent(id, 'running', 'pending', { expectedExecutionToken: token, executionToken: null, incrementRetry: true, maxRetryCount: 3 })
    case 'progress': return updateTaskProgressIfOwned(id, token, 99)
    case 'payload': return updateTaskPayloadIfOwned(id, token, { owner: token })
    case 'complete':
      return transitionTaskStatusIfCurrent(id, 'running', 'success', { expectedExecutionToken: token, executionToken: token, progress: 100 })
    case 'delete': return deleteTaskById(id)
    case 'legacySchema':
      setSetting('upgrade-test', 'preserve-me')
      getDb().exec("DROP TABLE task_operations; DELETE FROM _migrations WHERE id = '009_add_task_operations'")
      return true
    case 'setting': return getSetting('upgrade-test')
    case 'operationCount': return getDb().prepare('SELECT count(*) AS count FROM task_operations WHERE task_id = ?').get(id)
    case 'release': held.get(id)?.(); return true
    case 'effect':
      return runTaskOperation({ id, execution_token: token }, request.kind || 'upload', request.key || 'file', async () => {
        const wait = async () => {
          if (request.hold) {
            await new Promise<void>(resolve => {
              held.set(id, resolve)
              process.send?.({ held: id })
            })
          }
        }
        if (request.readOnly) await wait()
        return dispatchTaskMutation(async () => {
          // Independent, durable mock remote state survives killing this process.
          fs.appendFileSync(process.env.PANLITE_MOCK_REMOTE!, `${id}\n`)
          if (!request.readOnly) await wait()
          return { fileId: `remote:${id}`, size: 42 }
        })
      })
    default: throw new Error(`Unknown action: ${request.action}`)
  }
}
