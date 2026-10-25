import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbSearchSource } from './db'
const mocks = vi.hoisted(() => ({ fetchHtml: vi.fn(), fetchSearchText: vi.fn() }))
vi.mock('electron', () => ({ net: {} }))
vi.mock('./db', () => ({ getActiveSearchSources: vi.fn(), getActiveTgChannels: vi.fn(), getActiveCrawlerSources: vi.fn() }))
vi.mock('./crawler-utils', async importOriginal => ({ ...await importOriginal<typeof import('./crawler-utils')>(), ...mocks }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { searchApi } from './search-engine'
import { searchTgChannels } from './tg-crawler'
import { searchCrawlerSource } from './crawler-engine'
import { searchKk } from './kk-crawler'
beforeEach(() => vi.resetAllMocks())

describe('configured search source parsing with public-shaped fixtures', () => {
  it.each(['application/json', 'application/x-www-form-urlencoded'])('encodes API parameters consistently with %s', async contentType => {
    mocks.fetchSearchText.mockResolvedValue(JSON.stringify({ data: { items: [
      { name: '<b>中文文档</b>', link: 'https://pan.quark.cn/s/Fixture' },
    ] } }))
    const source = { name: 'Fixture API', platform: 'quark', url: 'https://fixture.invalid/api', method: 'POST',
      params: JSON.stringify({ q: '{keyword}' }), headers: JSON.stringify({ 'content-type': contentType }),
      field_map: JSON.stringify({ list_path: 'data.items', fields: { title: 'name', url: 'link' } }), max_count: 1,
    } as DbSearchSource
    const results = await searchApi(source, '中文')
    expect(results).toEqual([expect.objectContaining({ title: '中文文档', url: 'https://pan.quark.cn/s/Fixture' })])
    const options = mocks.fetchSearchText.mock.calls[0][1]
    expect(options.body).toBe(contentType === 'application/json' ? '{"q":"中文"}' : 'q=%E4%B8%AD%E6%96%87')
  })

  it('parses TG titles and passwords, filters disabled channels and deduplicates channels', async () => {
    mocks.fetchHtml.mockResolvedValue('<html><body><div class="tgme_widget_message_text">名称：<b>中文资源</b><br>https://pan.quark.cn/s/Fixture<br>提取码：abcd</div></body></html>')
    const channels = [
      { name: 'first', channel: 'first', platform: 'quark' },
      { name: 'second', channel: 'second', platform: 'quark' },
      { name: 'disabled', channel: 'disabled', platform: 'quark', status: 0 },
    ]
    expect(await searchTgChannels(channels, '中文')).toEqual([
      expect.objectContaining({ title: '中文资源', password: 'abcd', url: 'https://pan.quark.cn/s/Fixture?pwd=abcd' }),
    ])
    expect(mocks.fetchHtml).toHaveBeenCalledTimes(2)
  })

  it('follows a configured relative detail link and extracts the resource', async () => {
    mocks.fetchHtml.mockResolvedValueOnce('<html><body><div class="item"><h3 class="title">Document</h3><a class="detail" href="/details/1">details</a></div></body></html>')
      .mockResolvedValueOnce('<div class="content"><a href="https://pan.quark.cn/s/Detail">Download</a></div>')
    const results = await searchCrawlerSource({ name: 'Web', platform: 'quark', url: 'https://fixture.invalid/search?q={keyword}',
      htmlItem: 'div+item', htmlTitle: 'h3+title', htmlUrl: 'a+detail', htmlUrl2: 'div+content', htmlType: 1,
    }, 'doc')
    expect(results).toEqual([expect.objectContaining({ title: 'Document', url: 'https://pan.quark.cn/s/Detail' })])
    expect(mocks.fetchHtml).toHaveBeenLastCalledWith('https://fixture.invalid/details/1', 10000)
  })

  it('uses the KK token in JSON requests without duplicating an existing extraction code', async () => {
    mocks.fetchSearchText.mockResolvedValueOnce('{"token":"fixture-token"}').mockResolvedValueOnce(JSON.stringify({ list: [
      { answer: '中文资源 https://pan.baidu.com/s/Fixture?pwd=abcd 提取码：abcd' },
    ] }))
    const results = await searchKk({ name: 'KK', platform: 'baidu', apiType: 1 }, '中文')
    expect(results[0]?.url).toBe('https://pan.baidu.com/s/Fixture?pwd=abcd')
    expect(JSON.parse(mocks.fetchSearchText.mock.calls[1][1].body)).toEqual({ name: '中文', token: 'fixture-token' })
  })
})
