import type { SearchResultItem } from '../shared/types'
import { PAN_PATTERNS } from '../shared/constants'
import { fetchHtml, stripHtml, decodeHtmlEntities } from './crawler-utils'
import log from 'electron-log'
import * as cheerio from 'cheerio'

/**
 * Telegram 频道资源爬虫
 * 参考 xinyue-search 的 handleTg 实现
 * 通过 t.me/s/ 公开频道搜索接口获取资源
 */


// ── TG频道爬虫配置 ──

export interface TgChannelConfig {
  name: string
  channel: string      // 频道名（不含 https://t.me/）
  platform: string     // 网盘平台
  maxCount?: number
  weight?: number
  status?: number
}

// ── 预置热门TG资源频道 ──

export const DEFAULT_TG_CHANNELS: TgChannelConfig[] = [
  // 夸克网盘资源频道
  { name: '夸克资源分享', channel: 'quark_share', platform: 'quark', maxCount: 20, weight: 100 },
  { name: '夸克网盘资源', channel: 'quark_resources', platform: 'quark', maxCount: 20, weight: 90 },
  // 百度网盘资源频道
  { name: '百度资源分享', channel: 'baidu_share', platform: 'baidu', maxCount: 20, weight: 100 },
  { name: '百度网盘资源', channel: 'baidu_resources', platform: 'baidu', maxCount: 20, weight: 90 },
  // UC网盘资源频道
  { name: 'UC资源分享', channel: 'uc_share', platform: 'uc', maxCount: 20, weight: 100 },
  // 迅雷网盘资源频道
  { name: '迅雷资源分享', channel: 'xunlei_share', platform: 'xunlei', maxCount: 20, weight: 100 },
  // 综合资源频道
  { name: '网盘资源合集', channel: 'pan_resources', platform: 'quark', maxCount: 20, weight: 80 },
  { name: '影视资源分享', channel: 'movie_share', platform: 'quark', maxCount: 20, weight: 70 },
]

// ── 核心爬虫函数 ──

/**
 * 从TG频道搜索资源
 * 与 xinyue-search 的 handleTg 逻辑完全一致
 *
 * @param channel 频道配置
 * @param keyword 搜索关键词
 * @returns 搜索结果列表
 */
export async function searchTgChannel(channel: TgChannelConfig, keyword: string): Promise<SearchResultItem[]> {
  try {
    const encodedKeyword = encodeURIComponent(keyword)
    const url = `https://t.me/s/${channel.channel}?q=${encodedKeyword}`

    log.info(`[TG Crawler] Searching channel "${channel.channel}" for "${keyword}"`)

    const html = await fetchHtml(url)

    if (!html || html.length < 100) {
      log.warn(`[TG Crawler] Empty or too short response from channel "${channel.channel}"`)
      return []
    }

    // 使用cheerio解析HTML（与xinyue-search的DOM解析一致）
    const $ = cheerio.load(html)
    const results: SearchResultItem[] = []
    const maxCount = channel.maxCount || 20

    // 与xinyue-search完全一致：查找 div.tgme_widget_message_text
    $('div.tgme_widget_message_text').each((_, element) => {
      if (results.length >= maxCount) return false // break

      const htmlContent = $.html(element)

      // 提取标题（与xinyue-search完全一致）
      let title = ''
      const titleMatch = htmlContent.match(/名称：(.+?)<br/i)
      if (titleMatch) {
        // 与xinyue-search一致：trim(html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8'))
        title = decodeHtmlEntities(stripHtml(titleMatch[1])).trim()
      } else {
        // 与xinyue-search一致：如果没有标题，使用搜索关键词
        title = keyword
      }

      // 提取网盘链接（与xinyue-search的平台判断逻辑一致）
      let panUrl = ''
      const platform = channel.platform

      if (platform === 'quark') {
        const match = htmlContent.match(/https:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+/)
        if (match) panUrl = match[0].trim()
      } else if (platform === 'uc') {
        const match = htmlContent.match(/https:\/\/drive\.uc\.cn\/s\/[a-zA-Z0-9]+/)
        if (match) panUrl = match[0].trim()
      } else if (platform === 'xunlei') {
        const match = htmlContent.match(/https:\/\/pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/)
        if (match) panUrl = match[0].trim()
      } else if (platform === 'baidu') {
        const match = htmlContent.match(/https:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/)
        if (match) panUrl = match[0].trim()
      }

      // 与xinyue-search一致：过滤不合法或无效链接
      if (title && panUrl) {
        // 提取提取码（xinyue-search没有这个功能，但我们添加了）
        let password: string | undefined
        const pwdMatch = htmlContent.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
        if (pwdMatch) {
          password = pwdMatch[1]
        }

        // 如果链接中没有pwd参数但找到了提取码，添加到链接
        let finalUrl = panUrl
        if (password && !panUrl.includes('?pwd=')) {
          finalUrl = `${panUrl}?pwd=${password}`
        }

        results.push({
          title,
          url: finalUrl,
          password,
          platform: channel.platform,
          sourceName: `TG: ${channel.name}`,
        })
      }

      return true // continue
    })

    log.info(`[TG Crawler] Found ${results.length} results in channel "${channel.channel}"`)
    return results

  } catch (err) {
    log.error(`[TG Crawler] Error searching channel "${channel.channel}":`, String(err))
    return []
  }
}

/**
 * 并发搜索多个TG频道
 * @param channels 频道配置列表
 * @param keyword 搜索关键词
 * @param platform 可选的平台过滤
 * @returns 去重后的搜索结果
 */
export async function searchTgChannels(
  channels: TgChannelConfig[],
  keyword: string,
  platform?: string
): Promise<SearchResultItem[]> {
  // 过滤启用的频道和平台
  const activeChannels = channels.filter(ch => {
    if (ch.status === 0) return false
    if (platform && ch.platform !== platform) return false
    return true
  })

  if (activeChannels.length === 0) return []

  // 并发搜索（最多5个并发）
  const MAX_CONCURRENT = 5
  const results: SearchResultItem[][] = []
  let index = 0

  async function worker() {
    while (index < activeChannels.length) {
      const channel = activeChannels[index++]
      try {
        const result = await searchTgChannel(channel, keyword)
        results.push(result)
      } catch (err) {
        log.warn(`[TG Crawler] Channel "${channel.name}" failed:`, String(err))
        results.push([])
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, activeChannels.length) }, () => worker())
  await Promise.all(workers)

  // 去重（按URL）
  const seen = new Set<string>()
  const uniqueResults: SearchResultItem[] = []

  for (const item of results.flat()) {
    const key = item.url.split('?')[0]
    if (!seen.has(key)) {
      seen.add(key)
      uniqueResults.push(item)
    }
  }

  return uniqueResults
}

/**
 * 测试TG频道是否可用
 * @param channel 频道名
 * @returns 是否可用
 */
export async function testTgChannel(channel: string): Promise<boolean> {
  try {
    const url = `https://t.me/s/${channel}`
    const html = await fetchHtml(url, 10000)
    return !!(html && html.includes('tgme_widget_message'))
  } catch {
    return false
  }
}
