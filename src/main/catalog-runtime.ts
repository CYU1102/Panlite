import { getAccountById, getDb } from './db'
import { getAdapter } from '../adapters/registry'
import { dbAccountToDriveAccount } from './ipc/account-mapping'
import { CatalogStore } from './catalog-store'
import { CatalogService } from './catalog-service'
import type { AccountStatus, Platform } from '../shared/types'
import { accountRequestBudget } from './account-request-budget'

let service: CatalogService | undefined

export function getCatalogService(): CatalogService {
  service ??= new CatalogService(new CatalogStore(getDb()), {
    getAccount(accountId) {
      const row = getAccountById(accountId)
      return row ? {
        id: row.id, nickname: row.nickname || '', platform: row.platform as Platform,
        status: row.status as AccountStatus,
      } : undefined
    },
    async listFiles(accountId, parentId) {
      const row = getAccountById(accountId)
      if (!row || row.status !== 'active') throw new Error('账号不存在或需要重新登录')
      const account = dbAccountToDriveAccount(row)
      return accountRequestBudget.run(account.id, 'background', () => getAdapter(account.platform).listFiles(account, parentId))
    },
  })
  return service
}

export function disposeCatalog(): void {
  service?.dispose()
  service = undefined
}

export async function recoverCatalogScans(): Promise<void> {
  await getCatalogService().recoverInterruptedScans()
}
