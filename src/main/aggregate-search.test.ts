import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveSearchSources: vi.fn(() => [] as Record<string, unknown>[]),
  getActiveCrawlerSources: vi.fn(() => [] as Record<string, unknown>[]),
  getActiveTgChannels: vi.fn(() => [] as Record<string, unknown>[]),
  getActiveKkSources: vi.fn(() => [] as Record<string, unknown>[]),
  searchWithBrowser: vi.fn(async () => [] as Record<string, unknown>[]),
  searchApi: vi.fn(async () => [] as Record<string, unknown>[]),
  searchCrawlerSource: vi.fn(async () => [] as Record<string, unknown>[]),
  searchTgChannel: vi.fn(async () => [] as Record<string, unknown>[]),
  searchKk: vi.fn(async () => [] as Record<string, unknown>[]),
}))

vi.mock('./db', () => mocks)
vi.mock('./browser-crawler', () => ({ searchWithBrowser: mocks.searchWithBrowser }))
vi.mock('./search-engine', () => ({ searchApi: mocks.searchApi }))
vi.mock('./crawler-engine', () => ({ searchCrawlerSource: mocks.searchCrawlerSource }))
vi.mock('./tg-crawler', () => ({ searchTgChannel: mocks.searchTgChannel }))
vi.mock('./kk-crawler', () => ({ searchKk: mocks.searchKk }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))

import { aggregateSearch } from './aggregate-search'

describe('aggregate search source independence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveSearchSources.mockReturnValue([])
    mocks.getActiveCrawlerSources.mockReturnValue([])
    mocks.getActiveTgChannels.mockReturnValue([])
    mocks.getActiveKkSources.mockReturnValue([])
  })

  const common = { name: '独立资源源', platform: 'quark', max_count: 10, weight: 100, status: 1 }
  const item = { title: '测试文档', url: 'https://pan.quark.cn/s/test', password: 'abcd', platform: 'quark' }

  it.each([
    { kind: 'crawler', getSources: mocks.getActiveCrawlerSources, search: mocks.searchCrawlerSource, extra: { url: 'https://example.test/?q={keyword}', html_item: '.item' }, source: common.name },
    { kind: 'TG', getSources: mocks.getActiveTgChannels, search: mocks.searchTgChannel, extra: { channel: 'test_channel' }, source: `TG: ${common.name}` },
    { kind: 'KK', getSources: mocks.getActiveKkSources, search: mocks.searchKk, extra: { api_type: 1 }, source: common.name },
  ])('searches a lone $kind source with no ordinary browser sources', async ({ getSources, search, extra, source }) => {
    getSources.mockReturnValue([{ ...common, ...extra }])
    search.mockResolvedValue([item])

    await expect(aggregateSearch('文档')).resolves.toEqual([{ ...item, source }])
    expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: common.name, platform: 'quark', maxCount: 10 }), '文档')
    expect(mocks.searchWithBrowser).not.toHaveBeenCalled()
  })

  it('returns an empty result without starting requests when all source groups are empty', async () => {
    await expect(aggregateSearch('文档')).resolves.toEqual([])
    expect(mocks.searchWithBrowser).not.toHaveBeenCalled()
    expect(mocks.searchApi).not.toHaveBeenCalled()
    expect(mocks.searchCrawlerSource).not.toHaveBeenCalled()
    expect(mocks.searchTgChannel).not.toHaveBeenCalled()
    expect(mocks.searchKk).not.toHaveBeenCalled()
  })

  it('passes the complete API configuration to the API search engine', async () => {
    const source = {
      ...common,
      id: 'api-source',
      type: 'api',
      url: 'https://example.test/search',
      method: 'POST',
      params: JSON.stringify({ query: '{keyword}' }),
      headers: JSON.stringify({ Authorization: 'Bearer test-only' }),
      field_map: JSON.stringify({ list_path: 'data.files', fields: { title: 'name', url: 'link' } }),
    }
    mocks.getActiveSearchSources.mockReturnValue([source])
    mocks.searchApi.mockResolvedValue([{ ...item, sourceName: source.name }])

    await expect(aggregateSearch('文档')).resolves.toEqual([{ ...item, source: source.name }])
    expect(mocks.searchApi).toHaveBeenCalledExactlyOnceWith(source, '文档')
    expect(mocks.searchWithBrowser).not.toHaveBeenCalled()
  })

  it('keeps HTML sources on the browser search path', async () => {
    mocks.getActiveSearchSources.mockReturnValue([{ ...common, type: 'html', url: 'https://example.test/?q={keyword}' }])
    mocks.searchWithBrowser.mockResolvedValue([{ ...item, sourceName: common.name }])

    await expect(aggregateSearch('文档')).resolves.toEqual([{ ...item, source: common.name }])
    expect(mocks.searchWithBrowser).toHaveBeenCalledExactlyOnceWith({ name: common.name, platform: 'quark', maxCount: 10, url: 'https://example.test/?q={keyword}' }, '文档')
    expect(mocks.searchApi).not.toHaveBeenCalled()
  })
})
