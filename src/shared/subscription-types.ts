import type { Platform, TransferLinkInput } from './types'

export interface SharedDirectoryOptions { parentId?: string; signal?: AbortSignal }
export interface SharedSaveOptions { sourceParentId?: string; signal?: AbortSignal }
export interface SharedDirectoryEntry {
  fileId: string
  name: string
  isDir: boolean
  size?: number
  /** Only a provider's full-file digest, never an arbitrary ETag or timestamp. */
  contentHash?: { algorithm: 'sha1' | 'md5'; value: string }
  raw?: unknown
}
export interface SharedDirectoryResult {
  shareId?: string
  title?: string
  entries: SharedDirectoryEntry[]
  /** Set only after every page in this directory has been read successfully. */
  complete: true
}
export interface ShareSubscriptionInput extends TransferLinkInput {
  id?: string
  expectedVersion?: number
  accountId: string
  platform: string
  title?: string
  targetDirId: string
  targetDirPath?: string
  scope?: 'root' | 'recursive'
  initialMode?: 'baseline' | 'save_existing'
  includeKeywords?: string[]
  excludeKeywords?: string[]
  extensions?: string[]
  preserveStructure?: boolean
  detectChanges?: boolean
}
export interface ShareSubscription extends Omit<ShareSubscriptionInput, 'id' | 'expectedVersion' | 'fileIds'> {
  id: string
  platform: Platform
  configVersion: number
  scope: 'root' | 'recursive'
  initialMode: 'baseline' | 'save_existing'
  includeKeywords: string[]
  excludeKeywords: string[]
  extensions: string[]
  preserveStructure: boolean
  detectChanges: boolean
  status: 'active' | 'paused'
  baselineComplete: boolean
  lastError: string
  failureCount: number
  lastCheckedAt?: number
  lastSyncedAt?: number
  nextCheckAt: number
  activeRunId?: string
  taskId?: string
  createdAt: number
  updatedAt: number
}
export interface SubscriptionEntry extends SharedDirectoryEntry {
  parentId: string
  relativePath: string
}
export interface SubscriptionWork {
  id: string
  parentId: string
  targetRelativePath: string
  entries: SubscriptionEntry[]
  kind: 'save' | 'directory'
  done?: boolean
  savedCount?: number
}
export interface SubscriptionRun {
  id: string
  subscriptionId: string
  configVersion: number
  state: 'pending' | 'running' | 'success' | 'superseded' | 'blocked'
  taskId?: string
  config: ShareSubscription
  snapshot: SubscriptionEntry[]
  work: SubscriptionWork[]
  error?: string
  createdAt: number
  updatedAt: number
}
export interface SubscriptionTaskPayload { subscriptionId: string; configVersion: number; runId: string }

export function supportsRecursiveSubscriptions(platform: string): boolean {
  return ['quark', 'uc', 'aliyun_web'].includes(platform)
}
