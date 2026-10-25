import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { getAdapter } from '../adapters/registry'
import type { AccountStatus, Platform } from '../shared/types'
import { getAccountById, getDb } from './db'
import { dbAccountToDriveAccount } from './ipc/account-mapping'
import { getCatalogService } from './catalog-runtime'
import { accountRequestBudget } from './account-request-budget'
import { StorageAnalysisStore } from './storage-analysis-store'
import { StorageAnalysisService } from './storage-analysis-service'

let service: StorageAnalysisService | undefined
export function getStorageAnalysisService(): StorageAnalysisService {
  service ??= new StorageAnalysisService(new StorageAnalysisStore(getDb()), {
    getAccount(id) {
      const row = getAccountById(id)
      return row ? { id: row.id, nickname: row.nickname || '', platform: row.platform as Platform, status: row.status as AccountStatus } : undefined
    },
    resolveEntry: input => getCatalogService().resolveEntry(input),
    async readMetadata(entry) {
      const row = getAccountById(entry.accountId)
      if (!row || row.status !== 'active') throw new Error('Account unavailable')
      const account = dbAccountToDriveAccount(row)
      const listing = await accountRequestBudget.run(account.id, 'background', () => getAdapter(account.platform).listFiles(account, entry.parentId))
      if (listing.parentId !== entry.parentId || listing.hasMore !== false) throw new Error('Incomplete metadata')
      const matches = listing.files.filter(file => file.id === entry.fileId && file.accountId === entry.accountId)
      if (matches.length !== 1) throw new Error('Unresolved identity')
      return matches[0]
    },
    async getQuota(id) {
      const row = getAccountById(id)
      if (!row || row.status !== 'active') throw new Error('Account unavailable')
      const account = dbAccountToDriveAccount(row), adapter = getAdapter(account.platform)
      return adapter.getQuota ? accountRequestBudget.run(id, 'background', () => adapter.getQuota!(account)) : null
    },
    async exportFile(content, format) {
      const result = await dialog.showSaveDialog({ title: '导出空间整理清单', defaultPath: `PanLite-整理清单-${new Date().toISOString().slice(0, 10)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await writeFile(result.filePath, content, { encoding: 'utf8' })
      return { cancelled: false, filePath: result.filePath }
    },
  })
  return service
}
export function disposeStorageAnalysis(): void { service = undefined }
