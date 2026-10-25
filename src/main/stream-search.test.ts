import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  send: vi.fn(), getActiveSearchSources: vi.fn(), getActiveTgChannels: vi.fn(), getActiveCrawlerSources: vi.fn(), getActiveKkSources: vi.fn(), getSetting: vi.fn(),
  searchApi: vi.fn(), searchTgChannel: vi.fn(), searchCrawlerSource: vi.fn(), searchKk: vi.fn(), searchWithBrowser: vi.fn(),
}))
vi.mock('electron', () => ({ BrowserWindow: { fromId: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('./db', () => mocks)
vi.mock('./search-engine', () => ({ searchApi: mocks.searchApi }))
vi.mock('./tg-crawler', () => ({ searchTgChannel: mocks.searchTgChannel }))
vi.mock('./crawler-engine', () => ({ searchCrawlerSource: mocks.searchCrawlerSource }))
vi.mock('./kk-crawler', () => ({ searchKk: mocks.searchKk }))
vi.mock('./browser-crawler', () => ({ searchWithBrowser: mocks.searchWithBrowser }))
vi.mock('./url-crypto', () => ({ encryptUrl: (url: string) => `encrypted:${url}` }))
import { executeStreamSearch, stopStreamSearch } from './stream-search'
import { getSearchSignal } from './search-runtime'

const result = { title: 'Fixture', url: 'https://pan.quark.cn/s/Fixture', platform: 'quark', sourceName: 'API' }
const source = { name: 'API', type: 'api', url: 'https://fixture.invalid/api', method: 'POST', params: '{"keyword":"{keyword}"}' }
function results() { return mocks.send.mock.calls.map(call => call[1]).filter(event => event.event === 'result').map(event => event.data) }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.getActiveSearchSources.mockReturnValue([source])
  mocks.getActiveTgChannels.mockReturnValue([])
  mocks.getActiveCrawlerSources.mockReturnValue([])
  mocks.getActiveKkSources.mockReturnValue([])
  mocks.searchApi.mockImplementation(async () => [{ ...result }])
})

describe('stream search lifecycle', () => {
  it('uses API type for body-based searches and separates platform and encryption caches', async () => {
    await executeStreamSearch(1, 'cache-options', 'quark', { showEncrypted: true })
    expect(results().slice(-1)[0]?.url).toBe(result.url)
    await executeStreamSearch(1, 'cache-options', 'quark', { showEncrypted: false })
    expect(results().slice(-1)[0]?.url).toBe(`encrypted:${result.url}`)
    await executeStreamSearch(1, 'cache-options', 'baidu', { showEncrypted: true })
    expect(mocks.searchApi).toHaveBeenCalledTimes(3)
    await executeStreamSearch(1, 'cache-options', 'quark', { showEncrypted: true })
    expect(mocks.searchApi).toHaveBeenCalledTimes(3)
    expect(mocks.searchWithBrowser).not.toHaveBeenCalled()
  })

  it('cancels the active transport and suppresses late events and remaining sources', async () => {
    let resolve!: (value: typeof result[]) => void
    let signal: AbortSignal | undefined
    mocks.getActiveSearchSources.mockReturnValue([source, { ...source, name: 'second' }])
    mocks.searchApi.mockImplementationOnce(() => {
      signal = getSearchSignal()
      return new Promise(resolvePromise => { resolve = resolvePromise })
    })
    const pending = executeStreamSearch(2, 'cancel-source')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    stopStreamSearch(2)
    const eventCount = mocks.send.mock.calls.length
    expect(signal?.aborted).toBe(true)
    resolve([{ ...result }])
    await pending
    expect(mocks.send).toHaveBeenCalledTimes(eventCount)
    expect(mocks.searchApi).toHaveBeenCalledTimes(1)
    await executeStreamSearch(2, 'cancel-source')
    expect(mocks.searchApi).toHaveBeenCalledTimes(3)
  })

  it('a newer search replaces the old search in the same window', async () => {
    let resolve!: (value: typeof result[]) => void
    mocks.searchApi.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const oldSearch = executeStreamSearch(3, 'old-search')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await executeStreamSearch(3, 'new-search', undefined, { showEncrypted: true })
    const eventCount = mocks.send.mock.calls.length
    resolve([{ ...result, title: 'Old result' }])
    await oldSearch
    expect(mocks.send).toHaveBeenCalledTimes(eventCount)
    expect(results().map(item => item.title)).toEqual(['Fixture'])
  })

  it('stops a window waiting for another window without cancelling the owner', async () => {
    let resolve!: (value: typeof result[]) => void
    let ownerSignal: AbortSignal | undefined
    mocks.searchApi.mockImplementationOnce(() => {
      ownerSignal = getSearchSignal()
      return new Promise(done => { resolve = done })
    })
    const owner = executeStreamSearch(4, 'shared-wait')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    const waiter = executeStreamSearch(5, 'shared-wait')
    stopStreamSearch(5)
    await waiter
    expect(ownerSignal?.aborted).toBe(false)
    resolve([{ ...result }])
    await owner
    expect(mocks.searchApi).toHaveBeenCalledTimes(1)
  })
})
