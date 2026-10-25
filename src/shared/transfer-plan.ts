import type { FileConflictPolicy, TaskStatus } from './types'

export interface TransferPlanLocation { accountId: string; rootId: string; rootPath: string }
export interface TransferPlanInput {
  id?: string
  /** Required when editing; prevents silently replacing a newer configuration. */
  expectedVersion?: number
  name: string
  source: TransferPlanLocation
  target: TransferPlanLocation
  /** Relative-path glob rules: *, ** and ?; directory matches exclude descendants. */
  exclude: string[]
  conflictPolicy: FileConflictPolicy
}
export interface TransferPlan extends Omit<TransferPlanInput, 'id' | 'expectedVersion'> {
  id: string
  version: number
  status: 'draft' | 'previewing' | 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'stale'
  latestPreviewId?: string
  latestRunId?: string
  createdAt: number
  updatedAt: number
}
export interface TransferContentHash { algorithm: 'md5' | 'sha1' | 'sha256'; value: string }
export interface TransferPlanObject {
  fileId: string; parentId: string; name: string; isDir: boolean; size: number; updatedAt: number
  hash?: TransferContentHash
}
export type TransferPlanCategory = 'add' | 'identical' | 'changed' | 'conflict' | 'review' | 'excluded' | 'directory'
export type TransferPlanAction = 'create' | 'overwrite' | 'rename' | 'skip' | 'merge' | 'review'
export interface TransferPreviewItem {
  id: string
  relativePath: string
  outputPath: string
  source: TransferPlanObject
  target?: TransferPlanObject
  category: TransferPlanCategory
  action: TransferPlanAction
  /** Review/conflict actions are never inferred from name, size or timestamp. */
  requiresDecision: boolean
  decision?: FileConflictPolicy
  reason: string
  mode: 'staged_transfer' | 'native_copy'
}
export interface TransferPreviewSummary {
  totalItems: number; fileCount: number; directoryCount: number
  addCount: number; identicalCount: number; changedCount: number; conflictCount: number; reviewCount: number; skipCount: number
  /** Total client download + upload bytes. Native copy contributes zero. */
  transferBytes: number
  /** Sequential transfer; worst case persistent parts + assembly + staging. */
  tempBytes: number
}
export interface TransferPreview {
  id: string; planId: string; planVersion: number; fingerprint: string; createdAt: number
  complete: boolean; executable: boolean; summary: TransferPreviewSummary
  failures: Array<{ side: 'source' | 'target'; path: string; reason: string }>
}
export interface TransferRun {
  id: string; planId: string; previewId: string; planVersion: number; taskId?: string; taskStatus?: TaskStatus
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'stale'
  totalItems: number; succeeded: number; skipped: number; failed: number; uncertain: number
  createdAt: number; updatedAt: number; finishedAt?: number; summary?: string
}
export interface TransferExecutionItem {
  itemId: string; relativePath: string; outputPath: string
  status: 'success' | 'skipped' | 'failed' | 'uncertain'
  remoteId?: string; error?: string; updatedAt: number
}
export interface TransferPlanPage { page?: number; pageSize?: number }
export type TransferPlanResult<T extends object = Record<never, never>> = ({ success: true } & T) | { success: false; error: string; code?: string }
export interface TransferPlansApi {
  listPlans(): Promise<TransferPlanResult<{ plans: TransferPlan[] }>>
  savePlan(input: TransferPlanInput): Promise<TransferPlanResult<{ plan: TransferPlan }>>
  removePlan(planId: string): Promise<TransferPlanResult>
  previewPlan(planId: string): Promise<TransferPlanResult<{ preview: TransferPreview }>>
  getPreview(input: { previewId: string; category?: TransferPlanCategory } & TransferPlanPage): Promise<TransferPlanResult<{ preview: TransferPreview; items: TransferPreviewItem[]; total: number; page: number; pageSize: number }>>
  resolvePreview(input: { previewId: string; decisions: Array<{ itemId: string; action: FileConflictPolicy }> }): Promise<TransferPlanResult<{ preview: TransferPreview }>>
  executePlan(input: { planId: string; previewId: string }): Promise<TransferPlanResult<{ run: TransferRun; taskId: string }>>
  listRuns(planId: string): Promise<TransferPlanResult<{ runs: TransferRun[] }>>
  getReport(input: { runId: string } & TransferPlanPage): Promise<TransferPlanResult<{ run: TransferRun; items: TransferExecutionItem[]; total: number; page: number; pageSize: number }>>
  /** JSON text contains only plan metadata, object evidence and results; no credentials/direct links. */
  exportPlan(input: { planId: string; previewId?: string; runId?: string }): Promise<TransferPlanResult<{ fileName: string; json: string }>>
}
export const TRANSFER_PLAN_CHANNELS = {
  listPlans: 'transfer-plans:list', savePlan: 'transfer-plans:save', removePlan: 'transfer-plans:remove',
  previewPlan: 'transfer-plans:preview', getPreview: 'transfer-plans:get-preview', resolvePreview: 'transfer-plans:resolve',
  executePlan: 'transfer-plans:execute', listRuns: 'transfer-plans:runs', getReport: 'transfer-plans:report', exportPlan: 'transfer-plans:export',
} as const satisfies Record<keyof TransferPlansApi, string>
