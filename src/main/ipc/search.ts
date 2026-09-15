import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { generateId } from '../../shared/utils'
import { getAllSearchSources, insertSearchSource, updateSearchSource, deleteSearchSource, type DbSearchSource, getAllTgChannels, insertTgChannel, updateTgChannel, deleteTgChannel, type DbTgChannel, getAllCrawlerSources, insertCrawlerSource, updateCrawlerSource, deleteCrawlerSource, type DbCrawlerSource, getAllKkSources, insertKkSource, updateKkSource, deleteKkSource, type DbKkSource } from '../db'
import { executeSearch } from '../search-engine'
import { executeStreamSearch, stopStreamSearch, verifyResourceUrl, verifyResourceUrls } from '../stream-search'
import { encryptUrl, decryptUrl } from '../url-crypto'
import { isRateLimited, getRateLimitResetSeconds } from '../concurrency-control'
import { aggregateSearch } from '../aggregate-search'
import log from 'electron-log'
import type { IpcRegistrar } from './types'

export function registerSearchIpcHandlers(ipcMain: IpcRegistrar): void {
  // ---- Aggregate Search handler ----

  ipcMain.handle('search:aggregate', async (_event, keyword: string) => {
    try {
      if (!keyword || keyword.trim().length === 0) {
        return { success: false, error: '请输入搜索关键词' }
      }

      log.info(`[Aggregate Search] Searching: ${keyword}`)
      const results = await aggregateSearch(keyword.trim())
      log.info(`[Aggregate Search] Found ${results.length} results`)

      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })


  // ---- Resource Search ----

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_LIST, async () => {
    try {
      const sources = getAllSearchSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_SAVE, async (_event, source: DbSearchSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateSearchSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = generateId()
        insertSearchSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteSearchSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_EXECUTE, async (_event, keyword: string, platform?: string) => {
    try {
      if (!keyword.trim()) return { success: false, error: '请输入搜索关键词' }
      const results = await executeSearch(keyword.trim(), platform)
      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Stream Search (SSE-like) ----

  ipcMain.handle(IPC_CHANNELS.SEARCH_STREAM_START, async (event, keyword: string, platform?: string, options?: { verifyLinks?: boolean }) => {
    try {
      if (!keyword.trim()) return { success: false, error: '请输入搜索关键词' }

      // 获取发送事件的窗口ID
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return { success: false, error: '无法获取窗口' }

      // 频率限制检查（与xinyue-search一致）
      const clientId = `window_${window.id}`
      if (isRateLimited(clientId)) {
        const resetSeconds = getRateLimitResetSeconds(clientId)
        return { success: false, error: `请求太过频繁，请 ${resetSeconds} 秒后再试` }
      }

      const windowId = window.id

      // 异步执行流式搜索（不等待完成）
      executeStreamSearch(windowId, keyword.trim(), platform, options).catch(err => {
        log.error('[Stream Search] Error:', String(err))
        // 发送错误事件
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.SEARCH_STREAM_EVENT, {
          event: 'error',
          data: { message: String(err) },
        })
      })

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_STREAM_STOP, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false, error: '无法获取窗口' }
    stopStreamSearch(window.id)
    return { success: true }
  })

  // ---- Link Verification ----

  ipcMain.handle(IPC_CHANNELS.LINK_VERIFY_SINGLE, async (_event, url: string) => {
    try {
      const result = await verifyResourceUrl(url)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.LINK_VERIFY_BATCH, async (_event, urls: string[]) => {
    try {
      const results = await verifyResourceUrls(urls)
      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- TG Channels ----

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_LIST, async () => {
    try {
      const channels = getAllTgChannels()
      return { success: true, channels }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_SAVE, async (_event, channel: DbTgChannel) => {
    try {
      const ts = Date.now()
      if (channel.id) {
        // Update existing
        updateTgChannel({ ...channel, updated_at: ts })
      } else {
        // Insert new
        const id = `tg_${generateId()}`
        insertTgChannel({ ...channel, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TG_CHANNELS_DELETE, async (_event, id: string) => {
    try {
      deleteTgChannel(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Crawler Sources ----

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_LIST, async () => {
    try {
      const sources = getAllCrawlerSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_SAVE, async (_event, source: DbCrawlerSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateCrawlerSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = `crawler_${generateId()}`
        insertCrawlerSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CRAWLER_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteCrawlerSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- Test Search Source ----

  ipcMain.handle('search:test-source', async (_event, source: any) => {
    try {
      // 动态导入搜索引擎
      const { searchApi } = await import('../search-engine')
      const testSource = {
        id: 'test',
        name: 'Test',
        type: source.type || 'api',
        platform: source.platform || 'quark',
        url: source.url,
        method: source.method || 'GET',
        params: source.params || null,
        headers: source.headers || null,
        field_map: source.field_map || null,
        html_selectors: null,
        max_count: 5,
        weight: 0,
        status: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      const results = await searchApi(testSource, '测试')
      return { success: true, resultCount: results.length, results: results.slice(0, 3) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- KK Sources ----

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_LIST, async () => {
    try {
      const sources = getAllKkSources()
      return { success: true, sources }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_SAVE, async (_event, source: DbKkSource) => {
    try {
      const ts = Date.now()
      if (source.id) {
        // Update existing
        updateKkSource({ ...source, updated_at: ts })
      } else {
        // Insert new
        const id = `kk_${generateId()}`
        insertKkSource({ ...source, id, created_at: ts, updated_at: ts })
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KK_SOURCES_DELETE, async (_event, id: string) => {
    try {
      deleteKkSource(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ---- URL Crypto ----

  ipcMain.handle(IPC_CHANNELS.URL_ENCRYPT, async (_event, url: string) => {
    try {
      const encrypted = encryptUrl(url)
      return { success: true, encrypted }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.URL_DECRYPT, async (_event, encryptedUrl: string) => {
    try {
      const decrypted = decryptUrl(encryptedUrl)
      return { success: true, decrypted }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

}
