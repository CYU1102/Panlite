import { getAccountById, getDb, getTaskById, invalidateFilesCacheParents } from './db'
import { getAdapter } from '../adapters/registry'
import { dbAccountToDriveAccount } from './ipc/account-mapping'
import { TransferPlanStore } from './transfer-plan-store'
import { TransferPlanService } from './transfer-plan-service'
import { executeTransferPlanTask } from './transfer-plan-executor'
import { registerTaskExtension } from './task-extensions'
import { createAndEnqueueTask, downloadTransferFile, getTransferTempRoot } from './task-runner'
import { accountRequestBudget, budgetDriveAdapter } from './account-request-budget'
import { isTaskStatus } from './task-state-machine'

let service: TransferPlanService | undefined
let unregister: (() => void) | undefined

export function getTransferPlanService(): TransferPlanService {
  if (service) return service
  const current = new TransferPlanService(new TransferPlanStore(getDb()), {
    getAccount(id) { const row = getAccountById(id); return row ? dbAccountToDriveAccount(row) : undefined },
    getAdapter: platform => budgetDriveAdapter(getAdapter(platform)),
    enqueueTask: input => createAndEnqueueTask(input.accountId, input.platform, input.type, input.title, input.payload),
    getTaskStatus: taskId => { const status = getTaskById(taskId)?.status; return isTaskStatus(status) ? status : undefined },
    request: (accountId, execute, signal) => accountRequestBudget.run(accountId, 'interactive', execute, signal),
  })
  current.recoverInterruptedPreviews()
  unregister = registerTaskExtension('planned_transfer', context => executeTransferPlanTask(context, {
    service: current,
    tempRoot: getTransferTempRoot,
    onTargetChanged: invalidateFilesCacheParents,
    download: input => downloadTransferFile({
      task: input.context.task, account: input.account, adapter: input.adapter,
      fileId: input.item.source.fileId, fileSize: input.item.source.size,
      sourceParentId: input.item.source.parentId, expectedHash: input.item.source.hash,
      localPath: input.targetPath, signal: input.context.signal, onProgress: input.onProgress,
    }),
  }))
  service = current
  return current
}

export function disposeTransferPlans(): void {
  service?.dispose()
  unregister?.()
  service = undefined
  unregister = undefined
}
