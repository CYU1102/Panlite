import type { CatalogApi, CatalogEntry } from '@shared/catalog'
import type { DriveAccount, FileItem } from '@shared/types'

export interface CatalogLocation { account: Omit<DriveAccount, 'credential'>; entry: CatalogEntry }

export async function resolveCatalogLocation(
  query: Record<string, unknown>,
  catalog: Pick<CatalogApi, 'resolveEntry'>,
  listAccounts: () => Promise<{ success: boolean; accounts: Omit<DriveAccount, 'credential'>[] }>,
): Promise<CatalogLocation> {
  if (typeof query.accountId !== 'string' || typeof query.fileId !== 'string'
    || !query.accountId || !query.fileId || query.accountId.length > 4096 || query.fileId.length > 4096) {
    throw new Error('文件定位参数无效，请从文件目录重新打开')
  }
  const result = await catalog.resolveEntry({ accountId: query.accountId, fileId: query.fileId })
  if (!result.success) throw new Error(result.error)
  if (result.entry.accountId !== query.accountId || result.entry.fileId !== query.fileId) {
    throw new Error('文件身份与定位请求不一致')
  }
  const accounts = await listAccounts()
  const account = accounts.success && accounts.accounts.find(item => item.id === query.accountId)
  if (!account || account.status !== 'active') throw new Error('源账号不存在或需要重新登录')
  return { account, entry: result.entry }
}

/** A failed live read must not silently turn a catalog link into stale actions. */
export function confirmCatalogLocation(
  entry: Pick<CatalogEntry, 'accountId' | 'fileId' | 'parentId'>,
  result: { success: boolean; cached?: boolean; hasMore?: boolean; files: FileItem[] },
): FileItem[] {
  if (!result.success || result.cached || result.hasMore) throw new Error('无法在线确认目标文件，请重新连接账号后再试')
  const target = result.files.find(item => item.id === entry.fileId && item.accountId === entry.accountId)
  if (!target) throw new Error('目标文件已移动或删除，请重新扫描文件目录')
  return [target, ...result.files.filter(item => item !== target)]
}
