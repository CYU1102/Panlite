import type { TaskStatus } from './types'

export interface FileBackupTarget { accountId: string; rootId: string; rootPath: string }
export interface FileBackupPlanInput {
  id?: string
  expectedVersion?: number
  name: string
  sourcePath: string
  /** Phase C pilot supports WebDAV accounts with complete read/write capabilities only. */
  target: FileBackupTarget
  /** Relative-path globs (*, **, ?); matching a directory excludes its descendants. */
  exclude: string[]
  keepLast: number
  keepDays: number
}
export interface FileBackupPlan extends Omit<FileBackupPlanInput, 'id' | 'expectedVersion'> {
  id: string; version: number; createdAt: number; updatedAt: number
  latestSnapshotId?: string; latestJobId?: string
}
export type FileBackupSnapshotStatus = 'queued' | 'running' | 'ready' | 'failed' | 'uncertain' | 'damaged' | 'deleting' | 'deleted'
export interface FileBackupSnapshot {
  id: string; planId: string; planVersion: number; status: FileBackupSnapshotStatus; fingerprint: string
  sourcePath: string; createdAt: number; completedAt?: number; taskId?: string; taskStatus?: TaskStatus
  fileCount: number; directoryCount: number; totalBytes: number; uploadedFiles: number; reusedFiles: number; error?: string
}
export interface FileBackupEntry {
  relativePath: string; isDir: boolean; size: number; sha256?: string; objectId?: string
}
export interface FileBackupPreviewItem extends FileBackupEntry {
  action: 'upload' | 'reuse' | 'directory' | 'excluded' | 'blocked'
  reason?: string
}
export interface FileBackupPreview {
  id: string; planId: string; planVersion: number; fingerprint: string; createdAt: number
  complete: boolean; executable: boolean; unchanged: boolean; previousSnapshotId?: string
  fileCount: number; directoryCount: number; totalBytes: number; uploadFiles: number; uploadBytes: number; reusedFiles: number; excludedCount: number
  failures: Array<{ path: string; error: string }>
}
export interface FileRestorePreviewItem extends FileBackupEntry {
  action: 'create' | 'overwrite' | 'directory' | 'blocked'; reason?: string
}
export interface FileRestorePreview {
  id: string; snapshotId: string; planId: string; targetPath: string; overwrite: boolean; createdAt: number
  /** Omitted means the whole version. Selected directories include descendants; file selections retain necessary parent directories. */
  relativePaths?: string[]
  executable: boolean; fileCount: number; directoryCount: number; totalBytes: number; overwriteCount: number
  failures: Array<{ path: string; error: string }>
}
export interface FileBackupRetentionObject {
  objectId: string; name: string; size: number; sha256: string; referenceCount: number
  state: 'verified' | 'pending' | 'dispatched' | 'uncertain' | 'corrupt' | 'deleting' | 'deleted'
}
export interface FileBackupRetentionPreview {
  id: string; planId: string; planVersion: number; createdAt: number; executable: boolean
  snapshotIds: string[]; retainedSnapshotCount: number; objectCount: number; reclaimBytes: number; warnings: string[]
}
export interface FileBackupJob {
  id: string; planId: string; snapshotId?: string; previewId: string; kind: 'backup' | 'restore' | 'prune'; taskId?: string; taskStatus?: TaskStatus
  status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain'
  totalItems: number; completedItems: number; createdAt: number; updatedAt: number; error?: string
}
export interface FileBackupJobItem { itemId: string; path: string; status: 'success' | 'failed' | 'uncertain'; error?: string; updatedAt: number }
export interface FileBackupPage { page?: number; pageSize?: number }
export type FileBackupResult<T extends object = Record<never, never>> = ({ success: true } & T) | { success: false; error: string; code?: string }
export interface FileBackupsApi {
  listPlans(): Promise<FileBackupResult<{ plans: FileBackupPlan[] }>>
  savePlan(input: FileBackupPlanInput): Promise<FileBackupResult<{ plan: FileBackupPlan }>>
  /** Plans with retained versions cannot be removed until their snapshots have been explicitly pruned. */
  removePlan(planId: string): Promise<FileBackupResult>
  previewBackup(planId: string): Promise<FileBackupResult<{ preview: FileBackupPreview }>>
  getBackupPreview(input: { previewId: string } & FileBackupPage): Promise<FileBackupResult<{ preview: FileBackupPreview; items: FileBackupPreviewItem[]; total: number; page: number; pageSize: number }>>
  executeBackup(input: { planId: string; previewId: string }): Promise<FileBackupResult<{ snapshot: FileBackupSnapshot; taskId?: string; unchanged: boolean }>>
  listSnapshots(input: { planId: string } & FileBackupPage): Promise<FileBackupResult<{ snapshots: FileBackupSnapshot[]; total: number; page: number; pageSize: number }>>
  getSnapshot(input: { snapshotId: string } & FileBackupPage): Promise<FileBackupResult<{ snapshot: FileBackupSnapshot; entries: FileBackupEntry[]; total: number; page: number; pageSize: number }>>
  previewRestore(input: { snapshotId: string; targetPath: string; overwrite?: boolean; relativePaths?: string[] }): Promise<FileBackupResult<{ preview: FileRestorePreview }>>
  getRestorePreview(input: { previewId: string } & FileBackupPage): Promise<FileBackupResult<{ preview: FileRestorePreview; items: FileRestorePreviewItem[]; total: number; page: number; pageSize: number }>>
  executeRestore(previewId: string): Promise<FileBackupResult<{ job: FileBackupJob; taskId: string }>>
  /** Omit snapshotIds to apply keepLast OR keepDays. Explicit removal of every version is highlighted in preview warnings. */
  retentionPreview(input: { planId: string; snapshotIds?: string[] }): Promise<FileBackupResult<{ preview: FileBackupRetentionPreview }>>
  getRetentionPreview(input: { previewId: string } & FileBackupPage): Promise<FileBackupResult<{ preview: FileBackupRetentionPreview; objects: FileBackupRetentionObject[]; total: number; page: number; pageSize: number }>>
  prune(previewId: string): Promise<FileBackupResult<{ job: FileBackupJob; taskId: string }>>
  listJobs(planId: string): Promise<FileBackupResult<{ jobs: FileBackupJob[] }>>
  getJob(input: { jobId: string } & FileBackupPage): Promise<FileBackupResult<{ job: FileBackupJob; items: FileBackupJobItem[]; total: number; page: number; pageSize: number }>>
}
export const FILE_BACKUP_CHANNELS = {
  listPlans: 'file-backups:list', savePlan: 'file-backups:save', removePlan: 'file-backups:remove',
  previewBackup: 'file-backups:preview', getBackupPreview: 'file-backups:get-preview', executeBackup: 'file-backups:execute',
  listSnapshots: 'file-backups:snapshots', getSnapshot: 'file-backups:snapshot', previewRestore: 'file-backups:restore-preview',
  getRestorePreview: 'file-backups:get-restore-preview', executeRestore: 'file-backups:restore',
  retentionPreview: 'file-backups:retention-preview', getRetentionPreview: 'file-backups:get-retention-preview', prune: 'file-backups:prune',
  listJobs: 'file-backups:jobs', getJob: 'file-backups:job',
} as const satisfies Record<keyof FileBackupsApi, string>
