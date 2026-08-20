import type { AccountStatus, FileItem, Platform } from '../shared/types'

export type GlobalSearchFileType =
  | 'folder'
  | 'video'
  | 'audio'
  | 'image'
  | 'document'
  | 'archive'
  | string

export interface GlobalSearchFilters {
  accountIds?: string[]
  platforms?: Platform[]
  minSize?: number
  maxSize?: number
  fileTypes?: GlobalSearchFileType[]
  dateFrom?: number
  dateTo?: number
}

export interface GlobalSearchQuery {
  keyword: string
  filters: GlobalSearchFilters
}

export interface GlobalSearchAccount {
  id: string
  platform: Platform
  nickname: string
  status?: AccountStatus
}

export interface GlobalSearchResult extends FileItem {
  accountNickname: string
}

export interface GlobalSearchFailure {
  accountId: string
  accountNickname: string
  platform: Platform
  error: string
}

export interface GlobalSearchExecution {
  query: GlobalSearchQuery
  results: GlobalSearchResult[]
  failures: GlobalSearchFailure[]
  searchedAccountIds: string[]
}

export interface GlobalSearchHistoryEntry {
  id: string
  query: GlobalSearchQuery
  resultCount: number
  failureCount: number
  createdAt: number
}

export interface SavedGlobalSearch {
  id: string
  name: string
  query: GlobalSearchQuery
  createdAt: number
  updatedAt: number
}

export type SearchAccountFiles = (
  account: GlobalSearchAccount,
  keyword: string,
  filters: Omit<GlobalSearchFilters, 'accountIds' | 'platforms'>,
) => Promise<FileItem[]>

const TYPE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm']),
  audio: new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma']),
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']),
  document: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md']),
  archive: new Set(['zip', 'rar', '7z', 'tar', 'gz']),
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined
  return [...new Set(values)]
}

export function normalizeGlobalSearchQuery(query: GlobalSearchQuery): GlobalSearchQuery {
  const filters = query.filters || {}
  return {
    keyword: query.keyword.trim(),
    filters: {
      accountIds: uniqueStrings(filters.accountIds),
      platforms: uniqueStrings(filters.platforms) as Platform[] | undefined,
      minSize: filters.minSize,
      maxSize: filters.maxSize,
      fileTypes: uniqueStrings(filters.fileTypes),
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
  }
}

export function matchesGlobalSearchFilters(file: FileItem, filters: GlobalSearchFilters): boolean {
  if (filters.minSize !== undefined && file.size < filters.minSize) return false
  if (filters.maxSize !== undefined && file.size > filters.maxSize) return false
  if (filters.dateFrom !== undefined && file.updatedAt < filters.dateFrom) return false
  if (filters.dateTo !== undefined && file.updatedAt > filters.dateTo) return false

  if (filters.fileTypes?.length) {
    if (file.isDir) return filters.fileTypes.includes('folder')
    const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() || '' : ''
    const matchesType = filters.fileTypes.some((fileType) => {
      const extensions = TYPE_EXTENSIONS[fileType]
      return extensions ? extensions.has(extension) : fileType.toLowerCase() === extension
    })
    if (!matchesType) return false
  }

  return true
}

function selectAccounts(accounts: GlobalSearchAccount[], filters: GlobalSearchFilters): GlobalSearchAccount[] {
  const accountIds = filters.accountIds?.length ? new Set(filters.accountIds) : null
  const platforms = filters.platforms?.length ? new Set(filters.platforms) : null
  return accounts.filter((account) => (
    account.status !== 'expired'
    && account.status !== 'error'
    && (!accountIds || accountIds.has(account.id))
    && (!platforms || platforms.has(account.platform))
  ))
}

export async function executeGlobalSearch(
  accounts: GlobalSearchAccount[],
  inputQuery: GlobalSearchQuery,
  searchAccountFiles: SearchAccountFiles,
  concurrency = 4,
): Promise<GlobalSearchExecution> {
  const query = normalizeGlobalSearchQuery(inputQuery)
  if (!query.keyword) throw new Error('搜索关键词不能为空')
  if (query.filters.minSize !== undefined && query.filters.maxSize !== undefined
    && query.filters.minSize > query.filters.maxSize) {
    throw new Error('最小文件大小不能大于最大文件大小')
  }

  const selectedAccounts = selectAccounts(accounts, query.filters)
  const results: GlobalSearchResult[] = []
  const failures: GlobalSearchFailure[] = []
  const accountFilters = {
    minSize: query.filters.minSize,
    maxSize: query.filters.maxSize,
    fileTypes: query.filters.fileTypes,
    dateFrom: query.filters.dateFrom,
    dateTo: query.filters.dateTo,
  }
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < selectedAccounts.length) {
      const account = selectedAccounts[nextIndex++]
      try {
        const files = await searchAccountFiles(account, query.keyword, accountFilters)
        results.push(...files
          .filter((file) => matchesGlobalSearchFilters(file, query.filters))
          .map((file) => ({ ...file, accountNickname: account.nickname })))
      } catch (error) {
        failures.push({
          accountId: account.id,
          accountNickname: account.nickname,
          platform: account.platform,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const workerCount = Math.min(selectedAccounts.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return {
    query,
    results,
    failures,
    searchedAccountIds: selectedAccounts.map((account) => account.id),
  }
}

function queryKey(query: GlobalSearchQuery): string {
  const normalized = normalizeGlobalSearchQuery(query)
  return JSON.stringify({
    keyword: normalized.keyword.toLocaleLowerCase(),
    filters: normalized.filters,
  })
}

export function addGlobalSearchHistory(
  history: GlobalSearchHistoryEntry[],
  entry: GlobalSearchHistoryEntry,
  limit = 30,
): GlobalSearchHistoryEntry[] {
  const key = queryKey(entry.query)
  return [entry, ...history.filter((item) => queryKey(item.query) !== key)]
    .slice(0, Math.max(0, limit))
}

export function upsertSavedGlobalSearch(
  savedSearches: SavedGlobalSearch[],
  savedSearch: SavedGlobalSearch,
): SavedGlobalSearch[] {
  const normalized = {
    ...savedSearch,
    name: savedSearch.name.trim(),
    query: normalizeGlobalSearchQuery(savedSearch.query),
  }
  if (!normalized.name) throw new Error('保存条件名称不能为空')
  return [normalized, ...savedSearches.filter((item) => item.id !== normalized.id)]
}
