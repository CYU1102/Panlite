import type { StorageAnalysisApi } from '@shared/storage-analysis'
import { plainIpcData } from './plain-ipc-data'

declare global { interface Window { storageAnalysisAPI: StorageAnalysisApi } }

export const storageAnalysisApi: StorageAnalysisApi = {
  summary: input => window.storageAnalysisAPI.summary(plainIpcData(input)),
  listDirectories: input => window.storageAnalysisAPI.listDirectories(plainIpcData(input)),
  listLargeFiles: input => window.storageAnalysisAPI.listLargeFiles(plainIpcData(input)),
  listDuplicateGroups: input => window.storageAnalysisAPI.listDuplicateGroups(plainIpcData(input)),
  listGroupMembers: input => window.storageAnalysisAPI.listGroupMembers(plainIpcData(input)),
  verifyEvidence: input => window.storageAnalysisAPI.verifyEvidence(plainIpcData(input)),
  refreshQuotas: input => window.storageAnalysisAPI.refreshQuotas(plainIpcData(input)),
  createPlan: input => window.storageAnalysisAPI.createPlan(plainIpcData(input)),
  exportPlan: input => window.storageAnalysisAPI.exportPlan(plainIpcData(input)),
}
