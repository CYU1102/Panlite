import { net } from 'electron'
import type { SearchResultItem } from '../shared/types'
import { PAN_PATTERNS } from '../shared/constants'
import { getActiveSearchSources, getActiveTgChannels, getActiveCrawlerSources, type DbSearchSource, type DbTgChannel, type DbCrawlerSource } from './db'
import { searchTgChannels, type TgChannelConfig } from './tg-crawler'
import { searchCrawlerSources, type CrawlerSourceConfig } from './crawler-engine'
import log from 'electron-log'

// 导出searchApi函数供stream-search使用
export { searchApi }

/**
 * 全网资源搜索引擎
 * 参考 xinyue-search 的 web_search / all_search 实现
 * 支持两种搜索源类型：api（JSON API）和 html（网页爬虫）
 */

// 匹配所有平台的网盘链接
const ALL_PAN_PATTERN = /https?:\/\/(?:pan\.quark\.cn\/s\/[a-zA-Z0-9]+|pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?|drive\.uc\.cn\/s\/[a-zA-Z0-9]+|pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?)/

// ── 网络请求 ──

async function fetchUrl(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET'
    const timeout = options.timeout || 10000

    const request = net.request({ method, url })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        request.setHeader(k, v)
      }
    }

    if (options.body) {
      request.setHeader('Content-Length', String(Buffer.byteLength(options.body)))
      request.write(options.body)
    }

    const timer = setTimeout(() => {
      request.abort()
      reject(new Error('Request timeout'))
    }, timeout)

    let responseData = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString() })
      response.on('end', () => {
        clearTimeout(timer)
        resolve(responseData)
      })
      response.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    request.end()
  })
}

// ── 工具函数 ──

/** 用点号路径遍历对象（如 "data.list" → obj.data.list） */
function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split('.')
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 从文本中提取网盘链接 */
function extractPanUrl(text: string, platform?: string): string | null {
  if (!text) return null
  if (platform && PAN_PATTERNS[platform]) {
    const match = text.match(PAN_PATTERNS[platform])
    return match ? match[0] : null
  }
  const match = text.match(ALL_PAN_PATTERN)
  return match ? match[0] : null
}

/** 从文本中提取提取码 */
function extractPassword(text: string): string | null {
  if (!text) return null
  const match = text.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
  return match ? match[1] : null
}

// ── API 类型搜索 ──

async function searchApi(source: DbSearchSource, keyword: string): Promise<SearchResultItem[]> {
  try {
    const url = source.url.replace(/\{keyword\}/g, encodeURIComponent(keyword))
    const params = source.params ? JSON.parse(source.params) as Record<string, string> : {}
    const headers = source.headers ? JSON.parse(source.headers) as Record<string, string> : {}
    const fieldMap = source.field_map ? JSON.parse(source.field_map) as { list_path: string; fields: Record<string, string> } : null

    // 替换 params 中的 {keyword}
    for (const [k, v] of Object.entries(params)) {
      params[k] = v.replace(/\{keyword\}/g, keyword)
    }

    // 构建请求
    const method = (source.method || 'GET').toUpperCase()
    let requestUrl = url
    let body: string | undefined

    if (method === 'GET') {
      const qs = new URLSearchParams(params).toString()
      if (qs) requestUrl += (requestUrl.includes('?') ? '&' : '?') + qs
    } else {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(params).toString()
    }

    const responseText = await fetchUrl(requestUrl, { method, headers, body })
    const response = JSON.parse(responseText)

    // 用 field_map 提取结果
    if (!fieldMap) return []

    const list = getNestedValue(response, fieldMap.list_path)
    if (!Array.isArray(list)) return []

    const results: SearchResultItem[] = []
    const maxCount = source.max_count || 20

    for (const item of list) {
      if (results.length >= maxCount) break

      const title = String(getNestedValue(item, fieldMap.fields.title) || '')
      const rawUrl = String(getNestedValue(item, fieldMap.fields.url) || '')

      const panUrl = extractPanUrl(rawUrl, source.platform)
      if (!panUrl) continue

      const password = extractPassword(rawUrl) || extractPassword(title)

      results.push({
        title: title.replace(/<[^>]+>/g, '').trim() || '未知资源',
        url: panUrl,
        password: password || undefined,
        platform: source.platform,
        sourceName: source.name,
      })
    }

    return results
  } catch (err) {
    log.warn(`Search API error (${source.name}):`, String(err))
    return []
  }
}

// ── HTML 类型搜索 ──

function buildXPathSelector(tag: string, classStr: string): string {
  const classes = classStr.split(' ').filter(Boolean)
  if (classes.length === 0) return `//${tag}`
  const conditions = classes.map((c) => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`).join(' and ')
  return `//${tag}[${conditions}]`
}

function extractTextFromHtml(html: string, tag: string, classStr: string): string {
  // 简化的 HTML 解析：用正则提取
  const classPattern = classStr.split(' ').filter(Boolean).map((c) => `(?=.*\\b${c}\\b)`).join('')
  const regex = new RegExp(`<${tag}[^>]*class="[^"]*${classPattern}[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const match = html.match(regex)
  if (match) return match[1].replace(/<[^>]+>/g, '').trim()
  return ''
}

async function searchHtml(source: DbSearchSource, keyword: string): Promise<SearchResultItem[]> {
  try {
    const url = source.url.replace(/\{keyword\}/g, encodeURIComponent(keyword))
    const selectors = source.html_selectors ? JSON.parse(source.html_selectors) : null

    if (!selectors) return []

    const html = await fetchUrl(url, { timeout: 15000 })

    const results: SearchResultItem[] = []
    const maxCount = source.max_count || 20

    // 简化实现：用正则从整个 HTML 中提取网盘链接
    // 先提取所有网盘链接
    const urlMatches = html.match(new RegExp(ALL_PAN_PATTERN.source, 'g')) || []

    // 尝试提取标题（查找 "名称：" 或 "标题：" 格式）
    const titleMatches = html.match(/(?:名称|标题)[：:]\s*(.+?)(?:<br|<\/|$)/gi) || []

    for (let i = 0; i < Math.min(urlMatches.length, maxCount); i++) {
      const panUrl = urlMatches[i]
      let title = titleMatches[i]?.replace(/(?:名称|标题)[：:]\s*/i, '').replace(/<[^>]+>/g, '').trim() || ''

      if (!title) {
        // 尝试从链接周围的文本提取标题
        const urlIndex = html.indexOf(panUrl)
        if (urlIndex > 0) {
          const before = html.substring(Math.max(0, urlIndex - 200), urlIndex)
          const titleMatch = before.match(/[>"]([^<>"]{2,50})[<"」]?\s*$/)
          if (titleMatch) title = titleMatch[1].trim()
        }
      }

      const password = extractPassword(panUrl) || extractPassword(html.substring(html.indexOf(panUrl), html.indexOf(panUrl) + 100))

      results.push({
        title: title || '未知资源',
        url: panUrl,
        password: password || undefined,
        platform: source.platform,
        sourceName: source.name,
      })
    }

    return results
  } catch (err) {
    log.warn(`Search HTML error (${source.name}):`, String(err))
    return []
  }
}

// ── 搜索结果缓存（参考 xinyue-search 60秒缓存） ──

const SEARCH_CACHE_TTL_MS = 60 * 1000 // 60秒缓存
const searchCache: Map<string, { results: SearchResultItem[]; expiresAt: number }> = new Map()

function getCachedResults(keyword: string, platform?: string): SearchResultItem[] | null {
  const key = `${keyword}|${platform || ''}`
  const cached = searchCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    log.info(`Search cache hit for "${keyword}"`)
    return cached.results
  }
  if (cached) searchCache.delete(key)
  return null
}

function setCachedResults(keyword: string, platform: string | undefined, results: SearchResultItem[]): void {
  const key = `${keyword}|${platform || ''}`
  searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS })
  // 清理过期缓存
  if (searchCache.size > 100) {
    const now = Date.now()
    for (const [k, v] of searchCache) {
      if (v.expiresAt < now) searchCache.delete(k)
    }
  }
}

// ── 并发控制 ──

const MAX_CONCURRENT_SEARCHES = 5
const MAX_RETRY = 2
const RETRY_DELAY_MS = 1000

async function retryWithDelay<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRY, delayMs: number = RETRY_DELAY_MS): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)))
      }
    }
  }
  throw lastError
}

async function searchWithConcurrency(sources: DbSearchSource[], keyword: string): Promise<SearchResultItem[][]> {
  const results: SearchResultItem[][] = []
  let index = 0

  async function worker() {
    while (index < sources.length) {
      const source = sources[index++]
      try {
        const result = await retryWithDelay(async () => {
          if (source.type === 'api') return await searchApi(source, keyword)
          if (source.type === 'html') return await searchHtml(source, keyword)
          return []
        })
        results.push(result)
      } catch (err) {
        log.warn(`Search source "${source.name}" failed after retries:`, String(err))
        results.push([])
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_SEARCHES, sources.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ── 搜索调度 ──

/**
 * 将数据库TG频道配置转换为爬虫配置
 */
function dbTgChannelToConfig(channel: DbTgChannel): TgChannelConfig {
  return {
    name: channel.name,
    channel: channel.channel,
    platform: channel.platform,
    maxCount: channel.max_count,
    weight: channel.weight,
    status: channel.status,
  }
}

/**
 * 将数据库爬虫源配置转换为爬虫配置
 */
function dbCrawlerSourceToConfig(source: DbCrawlerSource): CrawlerSourceConfig {
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

/**
 * 执行全网资源搜索
 * 参考 xinyue-search web_search() 的搜索流程
 * 支持三种搜索源：API、TG频道、网页爬虫
 */
export async function executeSearch(keyword: string, platform?: string): Promise<SearchResultItem[]> {
  // 检查缓存
  const cached = getCachedResults(keyword, platform)
  if (cached) return cached

  // 获取所有活跃的搜索源
  const apiSources = getActiveSearchSources(platform)
  const tgChannels = getActiveTgChannels(platform)
  const crawlerSources = getActiveCrawlerSources(platform)

  const totalSources = apiSources.length + tgChannels.length + crawlerSources.length
  if (totalSources === 0) return []

  log.info(`Searching "${keyword}" across ${totalSources} sources (API: ${apiSources.length}, TG: ${tgChannels.length}, Crawler: ${crawlerSources.length})`)

  // 并发搜索所有类型的源
  const searchPromises: Promise<SearchResultItem[]>[] = []

  // API搜索
  if (apiSources.length > 0) {
    searchPromises.push(
      searchWithConcurrency(apiSources, keyword).then(results => results.flat())
    )
  }

  // TG频道搜索
  if (tgChannels.length > 0) {
    const tgConfigs = tgChannels.map(dbTgChannelToConfig)
    searchPromises.push(
      searchTgChannels(tgConfigs, keyword, platform)
    )
  }

  // 网页爬虫搜索
  if (crawlerSources.length > 0) {
    const crawlerConfigs = crawlerSources.map(dbCrawlerSourceToConfig)
    searchPromises.push(
      searchCrawlerSources(crawlerConfigs, keyword, platform)
    )
  }

  // 等待所有搜索完成
  const allResults = await Promise.all(searchPromises)
  const flatResults = allResults.flat()

  // 去重（按 URL）
  const seen = new Set<string>()
  const uniqueResults: SearchResultItem[] = []
  for (const item of flatResults) {
    const key = item.url.split('?')[0] // 忽略 query params 去重
    if (!seen.has(key)) {
      seen.add(key)
      uniqueResults.push(item)
    }
  }

  // 按相关度排序（标题匹配度）
  const keywordLower = keyword.toLowerCase()
  uniqueResults.sort((a, b) => {
    const aTitle = a.title.toLowerCase()
    const bTitle = b.title.toLowerCase()
    const aExact = aTitle.includes(keywordLower) ? 0 : 1
    const bExact = bTitle.includes(keywordLower) ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    // 按平台分组
    return a.platform.localeCompare(b.platform)
  })

  // 写入缓存
  setCachedResults(keyword, platform, uniqueResults)

  log.info(`Search completed: ${uniqueResults.length} unique results from ${totalSources} sources`)
  return uniqueResults
}
