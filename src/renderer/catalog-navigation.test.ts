import { describe, expect, it, vi } from 'vitest'
import type { CatalogEntry } from '@shared/catalog'
import type { DriveAccount, FileItem } from '@shared/types'
import { confirmCatalogLocation, resolveCatalogLocation } from './catalog-navigation'

const entry: CatalogEntry = {
  accountId: 'one', fileId: 'same-id', parentId: 'real-parent', name: '合同.pdf', path: '/项目/合同.pdf',
  isDir: false, size: 10, createdAt: 1, updatedAt: 2, indexedAt: 3, fileType: 'document',
  platform: 'webdav', accountNickname: '资料', accountStatus: 'active', tags: [], favorite: false, collectionIds: [],
}
const account: Omit<DriveAccount, 'credential'> = {
  id: 'one', platform: 'webdav', nickname: '资料', status: 'active', loginType: 'password', createdAt: 1, updatedAt: 2,
}
const file: FileItem = { id: entry.fileId, parentId: entry.parentId, name: entry.name, path: entry.path,
  accountId: entry.accountId, platform: entry.platform, isDir: false, size: 10, createdAt: 1, updatedAt: 2 }

describe('catalog navigation confirms live identity', () => {
  it('uses the confirmed parent instead of a forged or obsolete URL parent', async () => {
    const resolveEntry = vi.fn().mockResolvedValue({ success: true, entry })
    const result = await resolveCatalogLocation({ accountId: 'one', fileId: 'same-id', parentId: 'forged' },
      { resolveEntry }, async () => ({ success: true, accounts: [account] }))
    expect(result.entry.parentId).toBe('real-parent')
    expect(resolveEntry).toHaveBeenCalledWith({ accountId: 'one', fileId: 'same-id' })
  })

  it('rejects the same provider ID belonging to another account', async () => {
    await expect(resolveCatalogLocation({ accountId: 'one', fileId: 'same-id' }, {
      resolveEntry: async () => ({ success: true, entry: { ...entry, accountId: 'two' } }),
    }, async () => ({ success: true, accounts: [account] }))).rejects.toThrow('身份')
    expect(() => confirmCatalogLocation(entry, { success: true, files: [{ ...file, accountId: 'two' }] })).toThrow('移动或删除')
  })

  it('does not navigate when the account was removed or expired after resolution', async () => {
    for (const accounts of [[], [{ ...account, status: 'expired' as const }]]) {
      await expect(resolveCatalogLocation({ accountId: 'one', fileId: 'same-id' }, {
        resolveEntry: async () => ({ success: true, entry }),
      }, async () => ({ success: true, accounts }))).rejects.toThrow('重新登录')
    }
  })

  it('rejects cached, failed or partial results even when the file appears in them', () => {
    for (const response of [{ success: true, cached: true }, { success: false }, { success: true, hasMore: true }]) {
      expect(() => confirmCatalogLocation(entry, { ...response, files: [file] })).toThrow('在线确认')
    }
  })

  it('rejects a file that disappeared between resolution and directory loading', () => {
    expect(() => confirmCatalogLocation(entry, { success: true, files: [] })).toThrow('移动或删除')
  })

  it('locates the live target first without dropping other directory entries', () => {
    const other = { ...file, id: 'other', name: '其他.pdf' }
    expect(confirmCatalogLocation(entry, { success: true, files: [other, file] })).toEqual([file, other])
  })

  it('does not call the network with malformed URL values', async () => {
    const resolveEntry = vi.fn()
    await expect(resolveCatalogLocation({ accountId: ['one'], fileId: 'same-id' }, { resolveEntry },
      async () => ({ success: true, accounts: [account] }))).rejects.toThrow('参数')
    expect(resolveEntry).not.toHaveBeenCalled()
  })
})
