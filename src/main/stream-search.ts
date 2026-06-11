import { BrowserWindow } from 'electron'
import type { SearchResultItem } from '../shared/types'
import { getActiveSearchSources, getActiveTgChannels, getActiveCrawlerSources, getActiveKkSources, getSetting } from './db'
import { searchTgChannel, type TgChannelConfig } from './tg-crawler'
import { searchCrawlerSource, type CrawlerSourceConfig } from './crawler-engine'
import { searchKk, type KkSearchConfig } from './kk-crawler'
import { searchWithBrowser, type BrowserCrawlerSource } from './browser-crawler'
import { encryptUrl } from './url-crypto'
import { getCachedResults, setCachedResults, isProcessing, waitForResults, setProcessingLock, releaseProcessingLock } from './concurrency-control'
import { IPC_CHANNELS } from '../shared/constants'
import log from 'electron-log'

// ── 搜索结果排序算法 ──

interface ScoredResult extends SearchResultItem {
  _score: number
}

// 平台权重（用户量大的平台权重高）
const PLATFORM_WEIGHTS: Record<string, number> = {
  quark: 100,
  baidu: 95,
  uc: 85,
  xunlei: 80,
}

// 来源类型权重
const SOURCE_TYPE_WEIGHTS: Record<string, number> = {
  api: 100,
  browser: 90,
  kk: 80,
  tg: 70,
  crawler: 60,
}

/**
 * 计算搜索结果的相关性分数
 * 分数越高，排序越靠前
 */
function calculateScore(item: SearchResultItem, keyword: string, sourceWeight: number): number {
  let score = sourceWeight

  // 标题包含关键词加分
  const title = item.title.toLowerCase()
  const kw = keyword.toLowerCase()
  if (title.includes(kw)) {
    score += 50
    // 关键词在标题开头加分
    if (title.startsWith(kw)) {
      score += 20
    }
  }

  // 有提取码加分（说明是有效分享）
  if (item.password) {
    score += 30
  }

  // 平台权重
  const platformWeight = PLATFORM_WEIGHTS[item.platform] || 50
  score += platformWeight * 0.3

  return score
}

/**
 * 对搜索结果进行智能排序
 */
function sortResults(results: SearchResultItem[], keyword: string): SearchResultItem[] {
  // 为每个结果计算分数
  const scored: ScoredResult[] = results.map(item => ({
    ...item,
    _score: calculateScore(item, keyword, 100),
  }))

  // 按分数降序排序
  scored.sort((a, b) => b._score - a._score)

  // 移除分数字段，返回原始结果
  return scored.map(({ _score, ...item }) => item)
}

/**
 * 流式搜索引擎
 * 参考 xinyue-search 的 web_search 实现
 * 通过IPC事件实时推送搜索结果
 */

// ── 工具函数 ──

/** 检查关键词是否被屏蔽 */
function isKeywordBlocked(keyword: string): boolean {
  try {
    const bannedSetting = getSetting('bannedKeywords')
    if (!bannedSetting || !bannedSetting.value) return false

    const bannedKeywords = bannedSetting.value.split(',').map(k => k.trim()).filter(Boolean)
    return bannedKeywords.some(banned => keyword.includes(banned))
  } catch {
    return false
  }
}

/** 将数据库TG频道配置转换为爬虫配置 */
function dbTgChannelToConfig(channel: any): TgChannelConfig {
  return {
    name: channel.name,
    channel: channel.channel,
    platform: channel.platform,
    maxCount: channel.max_count,
    weight: channel.weight,
    status: channel.status,
  }
}

/** 将数据库爬虫源配置转换为爬虫配置 */
function dbCrawlerSourceToConfig(source: any): CrawlerSourceConfig {
  return {
    name: source.name,
    url: source.url,
    platform: source.platform,
    maxCount: source.max_count,
    weight: source.weight,
    status: source.status,
    htmlItem: source.html_item,
    htmlTitle: source.html_title,
    htmlUrl: source.html_url,
    htmlUrl2: source.html_url2,
    htmlType: source.html_type,
  }
}

/** 将数据库KK源配置转换为KK搜索配置 */
function dbKkSourceToConfig(source: any): KkSearchConfig {
  return {
    name: source.name,
    platform: source.platform,
    apiType: source.api_type,
    maxCount: source.max_count,
    weight: source.weight,
    status: source.status,
  }
}

/** 向前端发送流式事件 */
function sendStreamEvent(windowId: number, event: string, data: any): void {
  const window = BrowserWindow.fromId(windowId)
  if (window && !window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.SEARCH_STREAM_EVENT, { event, data })
  }
}

// ── 资源链接验证 ──

/**
 * 验证网盘链接是否有效
 * 通过调用网盘API获取分享详情来验证
 * 只有明确失效的才返回 invalid，其他都返回 valid（避免误判）
 */
export async function verifyResourceUrl(url: string): Promise<{
  valid: boolean
  title?: string
  fileCount?: number
  stoken?: string
  error?: string
}> {
  try {
    // 从URL中提取提取码
    let password = ''
    const pwdMatch = url.match(/\?pwd=([^,\s&]+)/)
    if (pwdMatch) {
      password = pwdMatch[1].trim()
    }

    // 判断平台类型
    let platform = ''
    if (url.includes('pan.quark.cn')) platform = 'quark'
    else if (url.includes('pan.baidu.com')) platform = 'baidu'
    else if (url.includes('drive.uc.cn')) platform = 'uc'
    else if (url.includes('pan.xunlei.com')) platform = 'xunlei'

    if (!platform) {
      return { valid: false, error: '不支持的网盘平台' }
    }

    // 获取适配器
    const { getAdapter } = require('../adapters/registry')
    const adapter = getAdapter(platform)

    if (!adapter.getShareDetail) {
      // 没有getShareDetail方法，假设有效
      return { valid: true }
    }

    // 创建一个临时账号用于验证
    const tempAccount = {
      id: 'verify',
      platform,
      credential: {},
    } as any

    try {
      const detail = await adapter.getShareDetail(tempAccount, { url, password })
      if (detail && detail.files && detail.files.length > 0) {
        return {
          valid: true,
          title: detail.title || detail.files[0]?.name,
          fileCount: detail.files.length,
        }
      }
      return { valid: false, error: '分享为空' }
    } catch (err: any) {
      const errMsg = String(err.message || err)
      // 只有明确的失效错误才标记为无效
      if (errMsg.includes('已失效') || errMsg.includes('expired') ||
          errMsg.includes('取消') || errMsg.includes('违规') ||
          errMsg.includes('SENSITIVE') || errMsg.includes('分享已过期')) {
        return { valid: false, error: '分享已失效' }
      }
      // 其他错误（如网络问题、登录问题）都假设有效
      return { valid: true, error: '无法验证，但链接格式正确' }
    }

  } catch (err) {
    // 验证出错，假设有效
    return { valid: true }
  }
}

/**
 * 批量验证资源链接
 */
export async function verifyResourceUrls(urls: string[]): Promise<Array<{
  url: string
  valid: boolean
  title?: string
  fileCount?: number
  error?: string
}>> {
  const results: Array<{ url: string; valid: boolean; title?: string; fileCount?: number; error?: string }> = []

  // 并发验证（最多3个并发）
  const MAX_CONCURRENT = 3
  let index = 0

  async function worker() {
    while (index < urls.length) {
      const url = urls[index++]
      try {
        const result = await verifyResourceUrl(url)
        results.push({ url, ...result })
      } catch (err) {
        results.push({ url, valid: false, error: String(err) })
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, urls.length) }, () => worker())
  await Promise.all(workers)

  return results
}

// ── 流式搜索 ──

/**
 * 执行流式搜索
 * 参考 xinyue-search 的 web_search 实现
 * 通过IPC事件实时推送搜索结果
 * 支持并发控制和缓存
 */
export async function executeStreamSearch(
  windowId: number,
  keyword: string,
  platform?: string,
  options?: {
    verifyLinks?: boolean  // 是否验证链接
    showEncrypted?: boolean // 是否显示加密链接
  }
): Promise<void> {
  const verifyLinks = options?.verifyLinks ?? false
  const showEncrypted = options?.showEncrypted ?? false

  // 检查关键词是否被屏蔽（与xinyue-search一致）
  if (isKeywordBlocked(keyword)) {
    sendStreamEvent(windowId, 'done', { message: '搜索词被屏蔽' })
    return
  }

  // 1. 检查缓存（与xinyue-search一致）
  const cachedResults = getCachedResults(keyword)
  if (cachedResults) {
    log.info(`[Stream Search] Cache hit for "${keyword}"`)
    sendStreamEvent(windowId, 'start', {
      keyword,
      platform,
      sourceCount: 0,
      cached: true,
    })

    // 直接发送缓存的结果
    for (const item of cachedResults) {
      sendStreamEvent(windowId, 'result', item)
    }

    sendStreamEvent(windowId, 'done', {
      message: '搜索完成（缓存）',
      totalResults: cachedResults.length,
    })
    return
  }

  // 2. 检查是否有正在进行的搜索（与xinyue-search一致）
  if (isProcessing(keyword)) {
    log.info(`[Stream Search] Waiting for ongoing search: "${keyword}"`)
    sendStreamEvent(windowId, 'start', {
      keyword,
      platform,
      sourceCount: 0,
      waiting: true,
    })

    sendStreamEvent(windowId, 'source', { name: '等待其他搜索完成...', count: 0 })

    // 等待其他搜索完成
    const results = await waitForResults(keyword)
    if (results) {
      for (const item of results) {
        sendStreamEvent(windowId, 'result', item)
      }
      sendStreamEvent(windowId, 'done', {
        message: '搜索完成（等待）',
        totalResults: results.length,
      })
      return
    }
  }

  // 3. 获取所有活跃的搜索源
  const apiSources = getActiveSearchSources(platform)
  const tgChannels = getActiveTgChannels(platform)
  const crawlerSources = getActiveCrawlerSources(platform)
  const kkSources = getActiveKkSources(platform)

  const totalSources = apiSources.length + tgChannels.length + crawlerSources.length + kkSources.length

  if (totalSources === 0) {
    sendStreamEvent(windowId, 'done', { message: '暂无可用搜索源' })
    return
  }

  log.info(`[Stream Search] Starting search for "${keyword}" across ${totalSources} sources`)

  // 4. 设置处理锁
  const searchPromise = performSearch(windowId, keyword, platform, {
    verifyLinks,
    showEncrypted,
    apiSources,
    tgChannels,
    crawlerSources,
    kkSources,
  })

  setProcessingLock(keyword, searchPromise as Promise<any[]>)

  try {
    const results = await searchPromise

    // 5. 缓存结果（与xinyue-search一致）
    setCachedResults(keyword, results)

  } finally {
    // 6. 释放处理锁
    releaseProcessingLock(keyword)
  }
}

/**
 * 执行实际的搜索操作
 */
async function performSearch(
  windowId: number,
  keyword: string,
  platform: string | undefined,
  options: {
    verifyLinks: boolean
    showEncrypted: boolean
    apiSources: any[]
    tgChannels: any[]
    crawlerSources: any[]
    kkSources: any[]
  }
): Promise<SearchResultItem[]> {
  const { verifyLinks, showEncrypted, apiSources, tgChannels, crawlerSources, kkSources } = options

  // 用于去重的Set
  const seen = new Set<string>()
  let resultCount = 0
  const allResults: SearchResultItem[] = []

  // 发送搜索开始事件
  sendStreamEvent(windowId, 'start', {
    keyword,
    platform,
    sourceCount: apiSources.length + tgChannels.length + crawlerSources.length + kkSources.length,
  })

  // 辅助函数：处理并发送结果
  async function processAndSendResult(item: SearchResultItem, sourceName: string, sourceWeight?: number): Promise<boolean> {
    const key = item.url.split('?')[0]
    if (seen.has(key)) return false
    seen.add(key)

    // 添加爬取时间戳和来源权重
    item.crawledAt = Date.now()
    item.sourceWeight = sourceWeight

    // 验证链接（如果启用）
    if (verifyLinks) {
      const verification = await verifyResourceUrl(item.url)
      if (!verification.valid) return false
    }

    // URL加密（如果启用，与xinyue-search的is_quan_type逻辑一致）
    const resultItem = { ...item, sourceName }
    if (!showEncrypted) {
      resultItem.url = encryptUrl(item.url)
    }

    allResults.push(resultItem)
    sendStreamEvent(windowId, 'result', resultItem)
    resultCount++
    return true
  }

  // 搜索API源（分为有搜索参数的API源和只有域名的浏览器爬虫源）
  const apiWithParams = apiSources.filter(s => s.url && s.url.includes('{keyword}'))
  const browserSources = apiSources.filter(s => s.url && !s.url.includes('{keyword}') && s.url.startsWith('http'))

  if (apiWithParams.length > 0) {
    sendStreamEvent(windowId, 'source', { name: 'API搜索源', count: apiWithParams.length })

    for (const source of apiWithParams) {
      try {
        // 使用动态导入避免循环依赖
        const { searchApi } = await import('./search-engine')
        const results = await searchApi(source, keyword)

        for (const item of results) {
          await processAndSendResult(item, source.name, source.weight || 100)
        }
      } catch (err) {
        log.warn(`[Stream Search] API source "${source.name}" failed:`, String(err))
      }
    }
  }

  // 浏览器爬虫源（只有域名，需要渲染页面提取链接）
  // 只搜索前3个权重最高的浏览器源，避免太慢
  if (browserSources.length > 0) {
    const topBrowserSources = browserSources.slice(0, 3)
    sendStreamEvent(windowId, 'source', { name: '浏览器爬虫', count: topBrowserSources.length })

    for (const source of topBrowserSources) {
      try {
        const browserConfig: BrowserCrawlerSource = {
          name: source.name,
          url: source.url,
          platform: source.platform,
          maxCount: source.max_count,
        }
        const results = await searchWithBrowser(browserConfig, keyword)

        for (const item of results) {
          await processAndSendResult(item, source.name, source.weight || 90)
        }
      } catch (err) {
        log.warn(`[Stream Search] Browser source "${source.name}" failed:`, String(err))
      }
    }
  }

  // 搜索TG频道
  if (tgChannels.length > 0) {
    sendStreamEvent(windowId, 'source', { name: 'TG频道', count: tgChannels.length })

    for (const channel of tgChannels) {
      try {
        const config = dbTgChannelToConfig(channel)
        const results = await searchTgChannel(config, keyword)

        for (const item of results) {
          await processAndSendResult(item, `TG: ${channel.name}`, channel.weight || 70)
        }
      } catch (err) {
        log.warn(`[Stream Search] TG channel "${channel.name}" failed:`, String(err))
      }
    }
  }

  // 搜索网页爬虫源
  if (crawlerSources.length > 0) {
    sendStreamEvent(windowId, 'source', { name: '网页爬虫', count: crawlerSources.length })

    for (const source of crawlerSources) {
      try {
        const config = dbCrawlerSourceToConfig(source)
        const results = await searchCrawlerSource(config, keyword)

        for (const item of results) {
          await processAndSendResult(item, source.name, source.weight || 60)
        }
      } catch (err) {
        log.warn(`[Stream Search] Crawler source "${source.name}" failed:`, String(err))
      }
    }
  }

  // 搜索KK源（与xinyue-search的handleKk一致）
  if (kkSources.length > 0) {
    sendStreamEvent(windowId, 'source', { name: 'KK搜索', count: kkSources.length })

    for (const source of kkSources) {
      try {
        const config = dbKkSourceToConfig(source)
        const results = await searchKk(config, keyword)

        for (const item of results) {
          await processAndSendResult(item, `KK: ${source.name}`, source.weight || 80)
        }
      } catch (err) {
        log.warn(`[Stream Search] KK source "${source.name}" failed:`, String(err))
      }
    }
  }

  // 搜索完成 - 对结果进行智能排序
  const sortedResults = sortResults(allResults, keyword)

  sendStreamEvent(windowId, 'done', {
    message: '搜索完成',
    totalResults: resultCount,
  })

  log.info(`[Stream Search] Completed: ${resultCount} results`)

  return sortedResults
}
