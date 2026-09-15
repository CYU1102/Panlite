import { TRANSFER_PLAN_CHANNELS, type TransferPlansApi } from './transfer-plan'

/** A fixed bridge keeps renderer callers within the plan API. */
export function createTransferPlansClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): TransferPlansApi {
  return {
    listPlans: () => invoke(TRANSFER_PLAN_CHANNELS.listPlans) as ReturnType<TransferPlansApi['listPlans']>,
    savePlan: input => invoke(TRANSFER_PLAN_CHANNELS.savePlan, input) as ReturnType<TransferPlansApi['savePlan']>,
    removePlan: id => invoke(TRANSFER_PLAN_CHANNELS.removePlan, id) as ReturnType<TransferPlansApi['removePlan']>,
    previewPlan: id => invoke(TRANSFER_PLAN_CHANNELS.previewPlan, id) as ReturnType<TransferPlansApi['previewPlan']>,
    getPreview: input => invoke(TRANSFER_PLAN_CHANNELS.getPreview, input) as ReturnType<TransferPlansApi['getPreview']>,
    resolvePreview: input => invoke(TRANSFER_PLAN_CHANNELS.resolvePreview, input) as ReturnType<TransferPlansApi['resolvePreview']>,
    executePlan: input => invoke(TRANSFER_PLAN_CHANNELS.executePlan, input) as ReturnType<TransferPlansApi['executePlan']>,
    listRuns: id => invoke(TRANSFER_PLAN_CHANNELS.listRuns, id) as ReturnType<TransferPlansApi['listRuns']>,
    getReport: input => invoke(TRANSFER_PLAN_CHANNELS.getReport, input) as ReturnType<TransferPlansApi['getReport']>,
    exportPlan: input => invoke(TRANSFER_PLAN_CHANNELS.exportPlan, input) as ReturnType<TransferPlansApi['exportPlan']>,
  }
}
