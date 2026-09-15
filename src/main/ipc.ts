import { app, ipcMain as electronIpcMain } from 'electron'
import { wrapTrustedIpcHandler } from './ipc-security'
import { registerEmbeddedBrowserHandlers } from './embedded-browser'
import type { IpcRegistrar } from './ipc/types'
import { registerSubscriptionIpcHandlers } from './ipc/subscriptions'
import { registerSecurityIpcHandlers, cleanupSecurityIpc } from './ipc/security'
import { registerAccountsIpcHandlers } from './ipc/accounts'
import { registerFilesIpcHandlers, cleanupFileIpc, getFilePreviewService } from './ipc/files'
import { registerTasksIpcHandlers } from './ipc/tasks'
import { registerTransfersIpcHandlers } from './ipc/transfers'
import { registerArchivesIpcHandlers } from './ipc/archives'
import { registerSearchIpcHandlers } from './ipc/search'
import { registerSettingsIpcHandlers } from './ipc/settings'
import { registerAiIpcHandlers, cleanupAiIpc } from './ipc/ai'
import { registerAppUpdateIpcHandlers } from './ipc/app-update'
import { registerCatalogIpcHandlers } from './ipc/catalog'
import { disposeCatalog, getCatalogService } from './catalog-runtime'
import { registerTransferPlansIpcHandlers } from './ipc/transfer-plans'
import { disposeTransferPlans, getTransferPlanService } from './transfer-plan-runtime'
import { registerStorageAnalysisIpcHandlers } from './ipc/storage-analysis'
import { disposeStorageAnalysis, getStorageAnalysisService } from './storage-analysis-runtime'
import { registerAiCitationPreviewIpc } from './ai/citation-preview'
import { cleanupDocumentWorkflowRuntime, registerDocumentWorkflowIpc } from './ai/document-workflow-ipc'
import { registerFileBackupsIpcHandlers } from './ipc/file-backups'
import { disposeFileBackups, getFileBackupService } from './file-backup-runtime'
import { registerAppSnapshotsIpcHandlers } from './ipc/app-snapshots'
import { getAppSnapshotService } from './app-snapshot-runtime'
import { registerAutomationRulesIpcHandlers } from './ipc/automation-rules'
import { disposeAutomationRules, getAutomationRuleService } from './automation-rule-runtime'

// All domain registrations pass through the same renderer-origin check.
const ipcMain: IpcRegistrar = {
  handle(channel, listener): void {
    electronIpcMain.handle(channel, wrapTrustedIpcHandler(listener))
  },
}

export function cleanupIpcResources(): void {
  disposeAutomationRules()
  disposeFileBackups()
  disposeStorageAnalysis()
  cleanupDocumentWorkflowRuntime()
  disposeCatalog()
  disposeTransferPlans()
  cleanupAiIpc()
  cleanupFileIpc()
  cleanupSecurityIpc()
}

export function registerIpcHandlers(): void {
  registerEmbeddedBrowserHandlers()
  registerSettingsIpcHandlers(ipcMain)
  registerAppUpdateIpcHandlers(ipcMain)
  registerSecurityIpcHandlers(ipcMain)
  registerAccountsIpcHandlers(ipcMain)
  registerFilesIpcHandlers(ipcMain)
  registerTasksIpcHandlers(ipcMain)
  registerTransfersIpcHandlers(ipcMain)
  registerArchivesIpcHandlers(ipcMain)
  registerSearchIpcHandlers(ipcMain)
  registerSubscriptionIpcHandlers(ipcMain)
  registerAiIpcHandlers(ipcMain)
  registerCatalogIpcHandlers(ipcMain, getCatalogService())
  registerTransferPlansIpcHandlers(ipcMain, getTransferPlanService())
  registerFileBackupsIpcHandlers(ipcMain, getFileBackupService())
  registerAppSnapshotsIpcHandlers(ipcMain, getAppSnapshotService(), () => { app.relaunch(); app.quit() })
  registerAutomationRulesIpcHandlers(ipcMain, getAutomationRuleService())
  registerStorageAnalysisIpcHandlers(ipcMain, getStorageAnalysisService())
  registerAiCitationPreviewIpc(ipcMain, getFilePreviewService())
  registerDocumentWorkflowIpc(ipcMain)
}
