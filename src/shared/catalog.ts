import type { AccountStatus, Platform } from './types'

/** File identity is always the pair (accountId, fileId), never a provider ID alone. */
export interface CatalogRef { accountId: string; fileId: string }
export type CatalogScanStatus = 'idle' | 'running' | 'paused' | 'completed' | 'partial' | 'error'
export type CatalogFileType = 'folder' | 'video' | 'audio' | 'image' | 'document' | 'archive' | 'other'
export interface CatalogFailure { directoryId: string; path: string; error: string }
export interface CatalogScope {
  id: string
  accountId: string
  accountNickname: string
  platform: Platform
  rootId: string
  rootPath: string
  status: CatalogScanStatus
  scannedDirectories: number
  pendingDirectories: number
  failedDirectories: number
  entryCount: number
  failures: CatalogFailure[]
  createdAt: number
  updatedAt: number
  lastScanAt: number | null
  lastCompletedAt: number | null
  accountStatus: AccountStatus | 'missing'
}
export interface CatalogScopeInput { accountId: string; rootId: string; rootPath: string }
export interface CatalogEntry extends CatalogRef {
  name: string
  parentId: string
  path: string
  isDir: boolean
  size: number
  createdAt: number
  updatedAt: number
  indexedAt: number
  fileType: CatalogFileType
  platform: Platform
  accountNickname: string
  accountStatus: AccountStatus | 'missing'
  tags: string[]
  favorite: boolean
  collectionIds: string[]
}
/** Name/path are literal substring filters; tags require all specified labels. Times are Unix milliseconds. */
export interface CatalogQuery {
  keyword?: string
  path?: string
  accountIds?: string[]
  scopeIds?: string[]
  fileTypes?: CatalogFileType[]
  minSize?: number
  maxSize?: number
  dateFrom?: number
  dateTo?: number
  tags?: string[]
  favorite?: boolean
  collectionId?: string
  page?: number
  pageSize?: number
  sortBy?: 'name' | 'size' | 'updatedAt' | 'indexedAt' | 'path'
  sortOrder?: 'asc' | 'desc'
}
export interface CatalogSearchPage { entries: CatalogEntry[]; total: number; page: number; pageSize: number }
export interface CatalogCollection { id: string; name: string; entryCount: number; createdAt: number; updatedAt: number }
export type CatalogResult<T extends object = Record<never, never>> = ({ success: true } & T) | { success: false; error: string }
export interface CatalogApi {
  listScopes(): Promise<CatalogResult<{ scopes: CatalogScope[] }>>
  addScope(input: CatalogScopeInput): Promise<CatalogResult<{ scope: CatalogScope }>>
  removeScope(scopeId: string): Promise<CatalogResult>
  startScan(scopeId: string): Promise<CatalogResult<{ scope: CatalogScope }>>
  pauseScan(scopeId: string): Promise<CatalogResult<{ scope: CatalogScope }>>
  resumeScan(scopeId: string): Promise<CatalogResult<{ scope: CatalogScope }>>
  search(query: CatalogQuery): Promise<CatalogResult<CatalogSearchPage>>
  listTags(): Promise<CatalogResult<{ tags: string[] }>>
  setTags(input: CatalogRef & { tags: string[] }): Promise<CatalogResult>
  setFavorite(input: CatalogRef & { favorite: boolean }): Promise<CatalogResult>
  listCollections(): Promise<CatalogResult<{ collections: CatalogCollection[] }>>
  saveCollection(input: { id?: string; name: string }): Promise<CatalogResult<{ collection: CatalogCollection }>>
  removeCollection(collectionId: string): Promise<CatalogResult>
  setEntryCollections(input: CatalogRef & { collectionIds: string[] }): Promise<CatalogResult>
  /** Read the indexed parent remotely and confirm this identity still exists before acting. */
  resolveEntry(input: CatalogRef): Promise<CatalogResult<{ entry: CatalogEntry }>>
}
export const CATALOG_CHANNELS = {
  listScopes: 'catalog:list-scopes', addScope: 'catalog:add-scope', removeScope: 'catalog:remove-scope',
  startScan: 'catalog:start-scan', pauseScan: 'catalog:pause-scan', resumeScan: 'catalog:resume-scan',
  search: 'catalog:search', listTags: 'catalog:list-tags', setTags: 'catalog:set-tags', setFavorite: 'catalog:set-favorite',
  listCollections: 'catalog:list-collections', saveCollection: 'catalog:save-collection', removeCollection: 'catalog:remove-collection',
  setEntryCollections: 'catalog:set-entry-collections', resolveEntry: 'catalog:resolve-entry',
} as const satisfies Record<keyof CatalogApi, string>
