import type { FileBackupsApi } from '@shared/file-backup'
import { plainIpcData } from './plain-ipc-data'

declare global { interface Window { fileBackupsAPI: FileBackupsApi } }

export const fileBackupsApi: FileBackupsApi = {
  listPlans: () => window.fileBackupsAPI.listPlans(),
  savePlan: input => window.fileBackupsAPI.savePlan(plainIpcData(input)),
  removePlan: input => window.fileBackupsAPI.removePlan(plainIpcData(input)),
  previewBackup: input => window.fileBackupsAPI.previewBackup(plainIpcData(input)),
  getBackupPreview: input => window.fileBackupsAPI.getBackupPreview(plainIpcData(input)),
  executeBackup: input => window.fileBackupsAPI.executeBackup(plainIpcData(input)),
  listSnapshots: input => window.fileBackupsAPI.listSnapshots(plainIpcData(input)),
  getSnapshot: input => window.fileBackupsAPI.getSnapshot(plainIpcData(input)),
  previewRestore: input => window.fileBackupsAPI.previewRestore(plainIpcData(input)),
  getRestorePreview: input => window.fileBackupsAPI.getRestorePreview(plainIpcData(input)),
  executeRestore: input => window.fileBackupsAPI.executeRestore(plainIpcData(input)),
  retentionPreview: input => window.fileBackupsAPI.retentionPreview(plainIpcData(input)),
  getRetentionPreview: input => window.fileBackupsAPI.getRetentionPreview(plainIpcData(input)),
  prune: input => window.fileBackupsAPI.prune(plainIpcData(input)),
  listJobs: input => window.fileBackupsAPI.listJobs(plainIpcData(input)),
  getJob: input => window.fileBackupsAPI.getJob(plainIpcData(input)),
}
