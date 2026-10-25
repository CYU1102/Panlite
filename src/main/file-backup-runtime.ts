import { getAccountById, getDb, getTaskById, type DbTask } from './db'
import type { FileBackupJob } from '../shared/file-backup'
import { getAdapter } from '../adapters/registry'
import { dbAccountToDriveAccount } from './ipc/account-mapping'
import { FileBackupStore } from './file-backup-store'
import { FileBackupService } from './file-backup-service'
import { executeFileBackupTask, executeFileRestoreTask, executeFileBackupPruneTask, type FileBackupExecutorDependencies } from './file-backup-executor'
import { registerTaskExtension } from './task-extensions'
import { createAndEnqueueTask, downloadTransferFile, getTransferTempRoot } from './task-runner'
import { accountRequestBudget, budgetDriveAdapter } from './account-request-budget'
import { isTaskStatus } from './task-state-machine'

let service: FileBackupService | undefined
let unregister: Array<() => void> = []

function findTaskByJob(job: FileBackupJob): { taskId: string; status: import('../shared/types').TaskStatus } | undefined {
  const rows = getDb().prepare(`SELECT * FROM tasks WHERE json_valid(payload)
    AND json_extract(payload,'$.jobId')=?`).all(job.id) as DbTask[]
  if (!rows.length) return undefined
  const row = rows[0], payload = JSON.parse(row.payload), plan = service?.store.plan(job.planId)
  const type = { backup: 'file_backup', restore: 'file_restore', prune: 'file_backup_prune' }[job.kind]
  if (rows.length !== 1 || !plan || row.task_type !== type || row.platform !== 'webdav' || row.account_id !== plan.target.accountId
    || (job.taskId && job.taskId !== row.id) || payload.planId !== job.planId || payload.previewId !== job.previewId
    || payload.snapshotId !== job.snapshotId || !isTaskStatus(row.status)) throw new Error('文件备份任务归属核对失败，已停止启动恢复')
  return { taskId: row.id, status: row.status }
}

export function getFileBackupService(): FileBackupService {
  if (service) return service
  const current = new FileBackupService(new FileBackupStore(getDb()), {
    getAccount(id) { const row = getAccountById(id); return row ? dbAccountToDriveAccount(row) : undefined },
    getAdapter: platform => budgetDriveAdapter(getAdapter(platform)),
    enqueueTask: input => createAndEnqueueTask(input.accountId, input.platform, input.type, input.title, input.payload),
    getTaskStatus: taskId => { const status = getTaskById(taskId)?.status; return isTaskStatus(status) ? status : undefined },
    findTaskByJob,
    request: (accountId, execute, signal) => accountRequestBudget.run(accountId, 'interactive', execute, signal),
  })
  const dependencies: FileBackupExecutorDependencies = {
    service: current, tempRoot: getTransferTempRoot,
    download: input => downloadTransferFile({
      task: input.context.task, account: input.account, adapter: input.adapter,
      fileId: input.file.id, fileSize: input.file.size, sourceParentId: input.file.parentId,
      expectedHash: { algorithm: 'sha256', value: input.expectedSha256 },
      localPath: input.targetPath, signal: input.context.signal, onProgress: input.onProgress,
    }),
  }
  unregister = [
    registerTaskExtension('file_backup', context => executeFileBackupTask(context, dependencies)),
    registerTaskExtension('file_restore', context => executeFileRestoreTask(context, dependencies)),
    registerTaskExtension('file_backup_prune', context => executeFileBackupPruneTask(context, dependencies)),
  ]
  service = current
  return current
}

export function disposeFileBackups(): void {
  service?.dispose()
  for (const dispose of unregister) dispose()
  unregister = []; service = undefined
}

export async function recoverFileBackupJobs(): Promise<void> { await getFileBackupService().recoverInterruptedJobs() }
