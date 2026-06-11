/**
 * 聚合搜索模块
 * 内嵌浏览器并发搜索用户配置的资源站
 */

import { getActiveSearchSources, getActiveCrawlerSources, getActiveTgChannels, getActiveKkSources } from './db'
import { searchCrawlerSource, type CrawlerSourceConfig } from './crawler-engine'
import { searchTgChannel, type TgChannelConfig } from './tg-crawler'
import { searchKk, type KkSearchConfig } from './kk-crawler'
import { searchWithBrowser, type BrowserCrawlerSource } from './browser-crawler'
import log from 'electron-log'

// ── 搜索结果类型 ──

export interface AggregateSearchResult {
  title: string
  url: string
  password?: string
  platform: string
  source: string
  size?: string
  createdAt?: string
  date?: string
}

// ── 主搜索函数：内嵌浏览器并发搜索 ──

/**
 * 聚合搜索
 * 用内嵌浏览器并发搜索用户配置的所有资源站
 */
export async function aggregateSearch(keyword: string): Promise<AggregateSearchResult[]> {
  const allResults: AggregateSearchResult[] = []

  log.info(`[AggregateSearch] Searching for: ${keyword}`)

  // 收集所有需要搜索的源
  const searchSources: BrowserCrawlerSource[] = []
  const crawlerSources = getActiveSearchSources()
  for (const s of crawlerSources) {
    searchSources.push({ name: s.name, url: s.url, platform: s.platform, maxCount: s.max_count || 20 })
  }

  if (searchSources.length === 0) {
    log.warn('[AggregateSearch] No search sources configured')
    return []
  }

  log.info(`[AggregateSearch] Searching ${searchSources.length} sources with browser crawler`)

  // 并发用浏览器搜索（最多同时 3 个，避免卡死）
  const batchSize = 3
  for (let i = 0; i < searchSources.length; i += batchSize) {
    const batch = searchSources.slice(i, i + batchSize)
    const promises = batch.map(source =>
      searchWithBrowser(source, keyword)
    )
    const results = await Promise.allSettled(promises)

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
          allResults.push({
            title: item.title,
            url: item.url,
            password: item.password,
            platform: item.platform,
            source: item.sourceName || 'unknown',
            date: item.date,
          })
        }
      }
    }
  }

  // 同时搜索爬虫源、TG频道、KK源
  const extraPromises: Promise<AggregateSearchResult[]>[] = []

  // 爬虫源
  const crawlerCfgs = getActiveCrawlerSources()
  if (crawlerCfgs.length > 0) {
    extraPromises.push(
      (async () => {
        const results: AggregateSearchResult[] = []
        for (const s of crawlerCfgs) {
          try {
            const config: CrawlerSourceConfig = {
              name: s.name, url: s.url, platform: s.platform,
              maxCount: s.max_count, weight: s.weight, status: s.status,
              htmlItem: s.html_item, htmlTitle: s.html_title,
              htmlUrl: s.html_url, htmlUrl2: s.html_url2, htmlType: s.html_type,
            }
            const items = await searchCrawlerSource(config, keyword)
            for (const item of items) {
              results.push({ title: item.title, url: item.url, password: item.password, platform: item.platform || s.platform, source: s.name })
            }
          } catch (err) {
            log.warn(`[AggregateSearch] Crawler ${s.name} failed:`, err)
          }
        }
        return results
      })()
    )
  }

  // TG频道
  const tgChannels = getActiveTgChannels()
  if (tgChannels.length > 0) {
    extraPromises.push(
      (async () => {
        const results: AggregateSearchResult[] = []
        for (const ch of tgChannels) {
          try {
            const config: TgChannelConfig = {
              name: ch.name, channel: ch.channel, platform: ch.platform,
              maxCount: ch.max_count, weight: ch.weight, status: ch.status,
            }
            const items = await searchTgChannel(config, keyword)
            for (const item of items) {
              results.push({ title: item.title, url: item.url, password: item.password, platform: item.platform || ch.platform, source: `TG: ${ch.name}` })
            }
          } catch (err) {
            log.warn(`[AggregateSearch] TG ${ch.name} failed:`, err)
          }
        }
        return results
      })()
    )
  }

  // KK源
  const kkSources = getActiveKkSources()
  if (kkSources.length > 0) {
    extraPromises.push(
      (async () => {
        const results: AggregateSearchResult[] = []
        for (const s of kkSources) {
          try {
            const config: KkSearchConfig = {
              name: s.name, platform: s.platform, apiType: s.api_type,
              maxCount: s.max_count, weight: s.weight, status: s.status,
            }
            const items = await searchKk(config, keyword)
            for (const item of items) {
              results.push({ title: item.title, url: item.url, password: item.password, platform: item.platform || s.platform, source: s.name })
            }
          } catch (err) {
            log.warn(`[AggregateSearch] KK ${s.name} failed:`, err)
          }
        }
        return results
      })()
    )
  }

  // 等待额外搜索完成
  if (extraPromises.length > 0) {
    const extraResults = await Promise.allSettled(extraPromises)
    for (const result of extraResults) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value)
      }
    }
  }

  log.info(`[AggregateSearch] Found ${allResults.length} raw results`)

  // 去重（按URL）
  const seen = new Set<string>()
  const uniqueResults = allResults.filter(item => {
    const key = item.url.split('?')[0]
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // 排序：按日期最新优先，有提取码的优先，然后按平台权重
  uniqueResults.sort((a, b) => {
    // 按日期排序（最新的在前）
    if (a.date && b.date) {
      const dateA = new Date(a.date).getTime()
      const dateB = new Date(b.date).getTime()
      if (!isNaN(dateA) && !isNaN(dateB) && dateA !== dateB) {
        return dateB - dateA
      }
    }

    // 有提取码的优先
    if (a.password && !b.password) return -1
    if (!a.password && b.password) return 1

    const weights: Record<string, number> = {
      quark: 100, baidu: 95, uc: 85,
      xunlei: 80,
    }
    return (weights[b.platform] || 50) - (weights[a.platform] || 50)
  })

  log.info(`[AggregateSearch] Returning ${uniqueResults.length} unique results`)
  return uniqueResults
}

/**
 * 格式化搜索结果为文本
 */
export function formatResults(results: AggregateSearchResult[]): string {
  if (results.length === 0) return '未找到相关资源'

  const lines = results.map((item, index) => {
    const pwd = item.password ? ` (提取码: ${item.password})` : ''
    return `${index + 1}. [${item.platform}] ${item.title}${pwd}\n   ${item.url}`
  })

  return lines.join('\n\n')
}
