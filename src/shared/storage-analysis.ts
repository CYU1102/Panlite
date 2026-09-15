import type { CatalogEntry, CatalogFileType, CatalogRef, CatalogResult, CatalogScope } from './catalog'
import type { AccountStatus, Platform } from './types'

export interface StorageFilter { accountIds?: string[]; scopeIds?: string[]; fileTypes?: CatalogFileType[] }
export interface StoragePageQuery extends StorageFilter { page?: number; pageSize?: number }
export interface StoragePage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface StorageTotals { bytes: number; fileCount: number; directoryCount: number; lastIndexedAt: number | null }
export interface StorageAccount extends StorageTotals {
  accountId: string; nickname: string; platform: Platform; status: AccountStatus | 'missing'
  quota: { used: number; total: number; checkedAt: number } | null
  /** Signed difference: quota may include trash, unindexed scopes and provider accounting. */
  quotaDifference: number | null
}
export interface StorageSummary extends StorageTotals {
  accounts: StorageAccount[]
  scopes: Array<CatalogScope & { indexedBytes: number; indexedFiles: number }>
  types: Array<{ fileType: CatalogFileType; bytes: number; fileCount: number }>
  coverage: { completeScopes: number; totalScopes: number; failedDirectories: number; pendingDirectories: number }
  generatedAt: number
}
export interface StorageDirectory extends CatalogRef {
  name: string; path: string; accountNickname: string; bytes: number; fileCount: number; isScopeRoot: boolean
}
export interface StorageEvidence { algorithm: 'md5' | 'sha1'; value: string; checkedAt: number; source: 'provider-metadata' }
export interface StorageMember extends CatalogEntry { evidence: StorageEvidence | null }
export interface StorageGroupKey { name: string; size: number }
export interface StorageDuplicateGroup extends StorageGroupKey {
  displayName: string; count: number; bytes: number; possibleReleaseBytes: number
  evidenceCount: number; distinctEvidenceCount: number; status: 'candidate' | 'confirmed' | 'different'
}
export interface StorageGroupQuery extends StoragePageQuery { status?: 'all' | 'candidate' | 'confirmed' | 'different' }
export interface StorageMembersQuery extends StoragePageQuery { group: StorageGroupKey }
export interface StoragePlanInput extends StorageFilter { group: StorageGroupKey; keep: CatalogRef; remove: CatalogRef[] }
export interface StoragePlan {
  generatedAt: number; keep: StorageMember; review: Array<StorageMember & { certainty: 'candidate' | 'confirmed' }>
  confirmedReleaseBytes: number; candidateReleaseBytes: number; notice: string
}
export interface StorageAnalysisApi {
  summary(filter: StorageFilter): Promise<CatalogResult<{ summary: StorageSummary }>>
  listDirectories(query: StoragePageQuery): Promise<CatalogResult<StoragePage<StorageDirectory>>>
  listLargeFiles(query: StoragePageQuery): Promise<CatalogResult<StoragePage<StorageMember>>>
  listDuplicateGroups(query: StorageGroupQuery): Promise<CatalogResult<StoragePage<StorageDuplicateGroup>>>
  listGroupMembers(query: StorageMembersQuery): Promise<CatalogResult<StoragePage<StorageMember>>>
  /** Only the explicitly selected files are read remotely; no content downloads. */
  verifyEvidence(input: { refs: CatalogRef[] }): Promise<CatalogResult<{ results: Array<CatalogRef & { status: 'verified' | 'unavailable' | 'error'; message: string }> }>>
  refreshQuotas(input: { accountIds: string[] }): Promise<CatalogResult<{ results: Array<{ accountId: string; success: boolean; message: string }> }>>
  createPlan(input: StoragePlanInput): Promise<CatalogResult<{ plan: StoragePlan }>>
  exportPlan(input: StoragePlanInput & { format: 'csv' | 'json' }): Promise<CatalogResult<{ cancelled: boolean; filePath?: string }>>
}
export const STORAGE_ANALYSIS_CHANNELS = {
  summary: 'storage-analysis:summary', listDirectories: 'storage-analysis:directories', listLargeFiles: 'storage-analysis:large-files',
  listDuplicateGroups: 'storage-analysis:duplicate-groups', listGroupMembers: 'storage-analysis:group-members',
  verifyEvidence: 'storage-analysis:verify-evidence', refreshQuotas: 'storage-analysis:refresh-quotas',
  createPlan: 'storage-analysis:create-plan', exportPlan: 'storage-analysis:export-plan',
} as const satisfies Record<keyof StorageAnalysisApi, string>
