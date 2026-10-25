import log from 'electron-log'
import { getDb, getTaskById, type DbTask } from './db'
import { getTransferPlanService } from './transfer-plan-runtime'
import { getFileBackupService } from './file-backup-runtime'
import { AutomationRuleService, type AutomationRuleDependencies } from './automation-rule-service'
import { AutomationRuleStore } from './automation-rule-store'
import { isTaskStatus } from './task-state-machine'
import type { AutomationActionOption } from '../shared/automation-rules'

let service: AutomationRuleService | undefined
function taskResult(row: DbTask | undefined): ReturnType<AutomationRuleDependencies['task']> {
  // Task errors may include adapter details. Keep rule history concise and
  // navigate to the existing sanitized task log for diagnostics.
  return row && isTaskStatus(row.status) ? { id: row.id, status: row.status } : undefined
}
export function getAutomationRuleService(): AutomationRuleService {
  if (service) return service
  const migrations = getTransferPlanService(), backups = getFileBackupService()
  service = new AutomationRuleService(new AutomationRuleStore(getDb()), {
    async listActions() {
      const [migrationResult, backupResult] = await Promise.all([migrations.listPlans(), backups.listPlans()])
      if (!migrationResult.success || !backupResult.success) throw new Error('无法加载计划')
      return [
        ...migrationResult.plans.map(plan => ({ kind: 'migration', planId: plan.id, planVersion: plan.version, name: plan.name } as AutomationActionOption)),
        ...backupResult.plans.map(plan => ({ kind: 'backup', planId: plan.id, planVersion: plan.version, name: plan.name } as AutomationActionOption)),
      ]
    },
    async prepare(action) {
      if (action.kind === 'migration') {
        const result = await migrations.previewPlan(action.planId)
        if (!result.success) return { executable: false, summary: result.error, itemCount: 0, writeCount: 0, transferBytes: 0 }
        const preview = result.preview, summary = preview.summary
        if (preview.planVersion !== action.planVersion) throw new Error('PLAN_VERSION')
        return { executable: preview.executable, previewId: preview.id, itemCount: summary.totalItems,
          writeCount: migrations.document(preview.id).items.filter(item => !item.source.isDir && ['create', 'overwrite', 'rename'].includes(item.action)).length,
          transferBytes: summary.transferBytes,
          summary: preview.executable ? `${summary.fileCount} 个文件，跳过 ${summary.skipCount} 项；执行时再次核对源和目标` : '目录未完整读取或存在待核对冲突，请到迁移计划处理' }
      }
      const result = await backups.previewBackup(action.planId)
      if (!result.success) return { executable: false, summary: result.error, itemCount: 0, writeCount: 0, transferBytes: 0 }
      const preview = result.preview
      if (preview.planVersion !== action.planVersion) throw new Error('PLAN_VERSION')
      return { executable: preview.executable, previewId: preview.id, itemCount: preview.fileCount + preview.directoryCount,
        writeCount: preview.uploadFiles, transferBytes: preview.uploadBytes,
        summary: preview.executable ? `${preview.fileCount} 个文件，上传 ${preview.uploadFiles} 个，复用 ${preview.reusedFiles} 个；完成前校验远端内容` : '备份源或目标未通过预演，请到版本备份检查' }
    },
    async execute(action, previewId) {
      if (action.kind === 'migration') {
        const result = await migrations.executePlan({ planId: action.planId, previewId })
        if (!result.success) throw new Error('计划执行需要重新核对')
        return { taskId: result.taskId }
      }
      const result = await backups.executeBackup({ planId: action.planId, previewId })
      if (!result.success) throw new Error('备份执行需要重新核对')
      return { taskId: result.taskId, summary: result.unchanged ? '内容未变化，已回读校验现有备份版本' : undefined }
    },
    task: id => taskResult(getTaskById(id)),
    findTaskByRun: runId => taskResult(getDb().prepare(`SELECT * FROM tasks
      WHERE task_type IN ('planned_transfer','file_backup') AND json_valid(payload)
      AND json_extract(payload,'$._automation.runId')=? ORDER BY created_at LIMIT 1`).get(runId) as DbTask | undefined),
    onError: () => log.warn('规则中心调度未完成，请检查规则历史和数据库状态'),
  })
  return service
}
export function startAutomationRules(): void { getAutomationRuleService().start() }
export function disposeAutomationRules(): void { service?.dispose(); service = undefined }
