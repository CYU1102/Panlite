import { describe, expect, it } from 'vitest'
import type { FileItem } from '../shared/types'
import {
  addGlobalSearchHistory,
  executeGlobalSearch,
  matchesGlobalSearchFilters,
  upsertSavedGlobalSearch,
  type GlobalSearchAccount,
  type GlobalSearchHistoryEntry,
} from './global-search'

const accounts: GlobalSearchAccount[] = [
  { id: 'baidu-a', platform: 'baidu', nickname: '百度 A', status: 'active' },
  { id: 'quark-b', platform: 'quark', nickname: '夸克 B', status: 'active' },
  { id: 'expired', platform: 'uc', nickname: '失效账号', status: 'expired' },
]

function file(account: GlobalSearchAccount, name: string, size = 10, updatedAt = 100): FileItem {
  return {
    id: `${account.id}-${name}`,
    parentId: '0',
    name,
    isDir: false,
    size,
    createdAt: updatedAt,
    updatedAt,
    platform: account.platform,
    accountId: account.id,
  }
}

describe('executeGlobalSearch', () => {
  it('searches selected accounts concurrently and annotates results', async () => {
    let active = 0
    let maximumActive = 0
    const releaseResolvers: Array<() => void> = []

    const executionPromise = executeGlobalSearch(
      accounts,
      { keyword: ' report ', filters: { platforms: ['baidu', 'quark'] } },
      async (account) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => releaseResolvers.push(resolve))
        active -= 1
        return [file(account, `${account.id}.pdf`)]
      },
      2,
    )

    await Promise.resolve()
    expect(maximumActive).toBe(2)
    releaseResolvers.splice(0).forEach((resolve) => resolve())
    const execution = await executionPromise

    expect(execution.searchedAccountIds).toEqual(['baidu-a', 'quark-b'])
    expect(execution.results.map((item) => item.accountNickname).sort()).toEqual(['夸克 B', '百度 A'])
  })

  it('keeps successful account results when another account fails', async () => {
    const execution = await executeGlobalSearch(
      accounts,
      { keyword: '资料', filters: {} },
      async (account) => {
        if (account.id === 'quark-b') throw new Error('登录已过期')
        return [file(account, '资料.txt')]
      },
    )

    expect(execution.results).toHaveLength(1)
    expect(execution.failures).toEqual([expect.objectContaining({ accountId: 'quark-b', error: '登录已过期' })])
  })

  it('validates inverted size ranges', async () => {
    await expect(executeGlobalSearch(
      accounts,
      { keyword: '资料', filters: { minSize: 20, maxSize: 10 } },
      async () => [],
    )).rejects.toThrow('最小文件大小')
  })
})

describe('global search filters', () => {
  it('filters by category, size and update time', () => {
    const target = file(accounts[0], 'movie.MP4', 200, 500)
    expect(matchesGlobalSearchFilters(target, {
      fileTypes: ['video'],
      minSize: 100,
      maxSize: 300,
      dateFrom: 400,
      dateTo: 600,
    })).toBe(true)
    expect(matchesGlobalSearchFilters(target, { fileTypes: ['image'] })).toBe(false)
    expect(matchesGlobalSearchFilters(target, { maxSize: 100 })).toBe(false)
  })
})

describe('global search collections', () => {
  it('deduplicates equivalent history and keeps the newest entry', () => {
    const oldEntry: GlobalSearchHistoryEntry = {
      id: 'old',
      query: { keyword: '报告', filters: { platforms: ['baidu'] } },
      resultCount: 1,
      failureCount: 0,
      createdAt: 1,
    }
    const newEntry = { ...oldEntry, id: 'new', resultCount: 3, createdAt: 2 }
    expect(addGlobalSearchHistory([oldEntry], newEntry)).toEqual([newEntry])
  })

  it('updates a saved condition by id and normalizes its name', () => {
    const saved = upsertSavedGlobalSearch([], {
      id: 'daily',
      name: ' 每日报告 ',
      query: { keyword: ' report ', filters: {} },
      createdAt: 1,
      updatedAt: 2,
    })
    expect(saved[0].name).toBe('每日报告')
    expect(saved[0].query.keyword).toBe('report')
    expect(() => upsertSavedGlobalSearch(saved, { ...saved[0], name: ' ' })).toThrow('名称不能为空')
  })
})
