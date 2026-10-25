import type { TransferPlansApi } from '@shared/transfer-plan'
import { plainIpcData } from './plain-ipc-data'

declare global { interface Window { transferPlansAPI: TransferPlansApi } }

export const transferPlansApi: TransferPlansApi = {
  listPlans: () => window.transferPlansAPI.listPlans(),
  savePlan: input => window.transferPlansAPI.savePlan(plainIpcData(input)),
  removePlan: id => window.transferPlansAPI.removePlan(id),
  previewPlan: id => window.transferPlansAPI.previewPlan(id),
  getPreview: input => window.transferPlansAPI.getPreview(plainIpcData(input)),
  resolvePreview: input => window.transferPlansAPI.resolvePreview(plainIpcData(input)),
  executePlan: input => window.transferPlansAPI.executePlan(plainIpcData(input)),
  listRuns: id => window.transferPlansAPI.listRuns(id),
  getReport: input => window.transferPlansAPI.getReport(plainIpcData(input)),
  exportPlan: input => window.transferPlansAPI.exportPlan(plainIpcData(input)),
}
