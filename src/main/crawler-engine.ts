import type { SearchResultItem } from '../shared/types'
import { PAN_PATTERNS } from '../shared/constants'
import { fetchHtml, stripHtml, decodeHtmlEntities } from './crawler-utils'
import log from 'electron-log'
import * as cheerio from 'cheerio'

/**
 * 通用网页爬虫引擎
 * 与 xinyue-search 的 handleWeb 逻辑完全一致
 * 支持从任意网页提取网盘资源链接
 */

// ── 网盘链接正则（与xinyue-search完全一致） ──

/** 构建完整URL（与xinyue-search的buildFullUrl一致） */
function buildFullUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http')) return url
  try {
    const parsed = new URL(baseUrl)
    const base = `${parsed.protocol}//${parsed.host}`
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
  } catch {
    return url
  }
}

// ── 爬虫配置接口（与xinyue-search的qf_api_list表结构对应） ──

export interface CrawlerSourceConfig {
  name: string
  url: string                       // 搜索URL模板，{keyword} 为关键词占位符
  platform: string                  // 目标网盘平台 (quark, baidu, uc, xunlei)
  maxCount?: number                 // 最大结果数
  weight?: number
  status?: number

  // 与xinyue-search的html_item, html_title, html_url, html_url2对应
  // 格式: "tag+class" (如 "div+resource-item" 或 "h3+title")
  htmlItem: string                  // 列表项选择器 (对应 html_item)
  htmlTitle: string                 // 标题选择器 (对应 html_title)
  htmlUrl: string                   // 详情页链接选择器 (对应 html_url)
  htmlUrl2: string                  // 内容区域选择器 (对应 html_url2)

  // 与xinyue-search的html_type对应
  // 0: 从列表页直接提取链接
  // 1: 需要进入详情页提取链接
  htmlType: number
}

// ── 预置爬虫源 ──

export const DEFAULT_CRAWLER_SOURCES: CrawlerSourceConfig[] = [
  // 可以在这里预置一些公开的资源网站
  // 示例配置（需要根据实际网站结构调整）：
  /*
  {
    name: '资源站示例',
    url: 'https://example.com/search?q={keyword}',
    platform: 'quark',
    maxCount: 20,
    weight: 100,
    htmlItem: 'div+resource-item',
    htmlTitle: 'h3+title',
    htmlUrl: 'a+detail-link',
    htmlUrl2: 'div+content',
    htmlType: 0,
  },
  */
]

// ── 核心爬虫函数（与xinyue-search完全一致） ──

/**
 * 构建XPath查询语句（与xinyue-search的buildXPathQuery一致）
 * 注意：cheerio不支持XPath，我们使用CSS选择器模拟
 */
function buildCssSelector(tag: string, classString: string): string {
  const classes = classString.split(' ').filter(Boolean)
  if (classes.length === 0) return tag
  return `${tag}.${classes.join('.')}`
}

/**
 * 解析 "tag+class" 格式的配置（与xinyue-search一致）
 */
function parseTagClass(config: string): { tag: string; classString: string } {
  const parts = config.split('+', 2)
  return {
    tag: parts[0] || '',
    classString: parts[1] || '',
  }
}

/**
 * 从HTML中提取标题（与xinyue-search的extractTitle完全一致）
 */
function extractTitle(html: string, htmlTitle: string): string {
  // 尝试匹配"名称：xxx 描述："格式
  const nameMatch = html.match(/名称：(.*?)\n\n描述：/s)
  if (nameMatch) {
    return stripHtml(nameMatch[1]).trim()
  }

  // 尝试根据标签和类名匹配
  const { tag, classString } = parseTagClass(htmlTitle)
  if (!tag) return ''

  const $ = cheerio.load(html)
  const selector = buildCssSelector(tag, classString)
  const element = $(selector).first()

  if (element.length > 0) {
    return stripHtml(element.html() || '').trim()
  }

  return ''
}

/**
 * 构建href属性匹配正则（与xinyue-search的buildHrefPattern一致）
 */
function buildHrefPattern(tag: string, classString: string): RegExp {
  if (!classString) {
    // 没有类名要求，只匹配标签中包含 href 的内容
    return new RegExp(`<${tag}\\b[^>]*href=["']([^"']+)["'][^>]*>`, 'i')
  } else {
    // 匹配包含指定 class 的标签，不要求 href 和 class 的顺序
    return new RegExp(`<${tag}\\b(?=[^>]*class=["'][^"']*${classString}[^"']*["'])(?=[^>]*href=["']([^"']+)["'])[^>]*>`, 'i')
  }
}

/**
 * 从列表页直接提取URL（与xinyue-search的extractUrlFromListPage一致）
 */
function extractUrlFromListPage(html: string, htmlUrl2: string, panPattern: RegExp): string {
  const { tag, classString } = parseTagClass(htmlUrl2)

  // 尝试从内容中提取
  const $ = cheerio.load(html)
  const selector = buildCssSelector(tag, classString)
  const elements = $(selector)

  for (const element of elements.toArray()) {
    const content = $(element).html() || ''
    const textContent = stripHtml(content)
    const match = textContent.match(panPattern)
    if (match) return match[0].trim()
  }

  // 尝试从href属性中提取
  const hrefPattern = buildHrefPattern(tag, classString)
  const hrefMatch = html.match(hrefPattern)
  if (hrefMatch) {
    const extractedUrl = hrefMatch[1].trim()
    const urlMatch = extractedUrl.match(panPattern)
    if (urlMatch) return urlMatch[0].trim()
  }

  return ''
}

/**
 * 从详情页提取URL（与xinyue-search的extractUrlFromDetailPage一致）
 */
async function extractUrlFromDetailPage(
  html: string,
  config: CrawlerSourceConfig,
  baseUrl: string,
  panPattern: RegExp
): Promise<string> {
  const { tag: tagD, classString: classStringD } = parseTagClass(config.htmlUrl)

  // 构建匹配详情页链接的正则表达式
  const detailUrlPattern = buildHrefPattern(tagD, classStringD)
  const match = html.match(detailUrlPattern)

  if (!match) return ''

  // 处理相对URL
  const detailUrl = match[1].trim()
  const fullDetailUrl = buildFullUrl(detailUrl, baseUrl)

  // 获取详情页内容
  const detailHtml = await fetchHtml(fullDetailUrl, 10000)
  if (!detailHtml) return ''

  const { tag: tagUrl, classString: classStringUrl } = parseTagClass(config.htmlUrl2)

  // 使用cheerio解析详情页
  const $ = cheerio.load(detailHtml)
  const selector = buildCssSelector(tagUrl, classStringUrl)
  const nodes = $(selector)

  // 遍历详情页节点查找网盘链接
  for (const node of nodes.toArray()) {
    const nodeHtml = $.html(node)

    // 尝试从内容中提取
    const contentSelector = buildCssSelector(tagUrl, classStringUrl)
    const contentElement = $(node).find(contentSelector).first()
    if (contentElement.length > 0) {
      const extractedUrl = stripHtml(contentElement.html() || '')
      const urlMatch = extractedUrl.match(panPattern)
      if (urlMatch) return urlMatch[0].trim()
    }

    // 尝试从href属性中提取
    const hrefPattern = buildHrefPattern(tagUrl, classStringUrl)
    const hrefMatch = nodeHtml.match(hrefPattern)
    if (hrefMatch) {
      const extractedUrl = hrefMatch[1].trim()
      const urlMatch = extractedUrl.match(panPattern)
      if (urlMatch) return urlMatch[0].trim()
    }
  }

  return ''
}

/**
 * 搜索单个爬虫源（与xinyue-search的handleWeb完全一致）
 */
export async function searchCrawlerSource(
  config: CrawlerSourceConfig,
  keyword: string
): Promise<SearchResultItem[]> {
  try {
    // 替换搜索关键词（与xinyue-search一致）
    const searchUrl = config.url.replace(/\{keyword\}/g, encodeURIComponent(keyword))

    log.info(`[Crawler] Searching "${config.name}" for "${keyword}"`)

    const html = await fetchHtml(searchUrl)
    if (!html) {
      log.warn(`[Crawler] Empty response from "${config.name}"`)
      return []
    }

    const results: SearchResultItem[] = []
    const maxCount = config.maxCount || 20
    const platform = config.platform

    // 获取网盘链接匹配规则（与xinyue-search一致）
    const panPattern = PAN_PATTERNS[platform]
    if (!panPattern) {
      log.warn(`[Crawler] Unknown platform: ${platform}`)
      return []
    }

    // 解析列表项选择器（与xinyue-search一致）
    const { tag, classString } = parseTagClass(config.htmlItem)

    // 使用cheerio解析HTML
    const $ = cheerio.load(html)
    const selector = buildCssSelector(tag, classString)
    const nodes = $(selector)

    for (const node of nodes.toArray()) {
      if (results.length >= maxCount) break

      const nodeHtml = $.html(node)
      const item = {
        title: '',
        url: '',
      }

      // 提取资源标题（与xinyue-search一致）
      item.title = extractTitle(nodeHtml, config.htmlTitle)

      // 尝试直接从当前HTML中提取网盘链接（与xinyue-search一致）
      const directMatch = nodeHtml.match(panPattern)
      if (directMatch) {
        item.url = directMatch[0].trim()
      } else {
        // 根据配置决定是否需要进入详情页（与xinyue-search一致）
        if (config.htmlType === 1) {
          item.url = await extractUrlFromDetailPage(nodeHtml, config, searchUrl, panPattern)
        } else {
          item.url = extractUrlFromListPage(nodeHtml, config.htmlUrl2, panPattern)
        }
      }

      // 只添加同时有标题和URL的结果（与xinyue-search一致）
      if (item.title && item.url) {
        // 提取提取码（xinyue-search没有这个功能，但我们添加了）
        let password: string | undefined
        const pwdMatch = nodeHtml.match(/(?:提取码|密码|pwd)[:\s：]*([a-zA-Z0-9]{4})/i)
        if (pwdMatch) {
          password = pwdMatch[1]
        }

        // 如果链接中没有pwd参数但找到了提取码，添加到链接
        let finalUrl = item.url
        if (password && !item.url.includes('?pwd=')) {
          finalUrl = `${item.url}?pwd=${password}`
        }

        results.push({
          title: item.title,
          url: finalUrl,
          password,
          platform: config.platform,
          sourceName: config.name,
        })
      }
    }

    log.info(`[Crawler] Found ${results.length} results from "${config.name}"`)
    return results

  } catch (err) {
    log.error(`[Crawler] Error searching "${config.name}":`, String(err))
    return []
  }
}

/**
 * 并发搜索多个爬虫源
 */
export async function searchCrawlerSources(
  sources: CrawlerSourceConfig[],
  keyword: string,
  platform?: string
): Promise<SearchResultItem[]> {
  // 过滤启用的源和平台
  const activeSources = sources.filter(s => {
    if (s.status === 0) return false
    if (platform && s.platform !== platform) return false
    return true
  })

  if (activeSources.length === 0) return []

  // 并发搜索（最多5个并发）
  const MAX_CONCURRENT = 5
  const results: SearchResultItem[][] = []
  let index = 0

  async function worker() {
    while (index < activeSources.length) {
      const source = activeSources[index++]
      try {
        const result = await searchCrawlerSource(source, keyword)
        results.push(result)
      } catch (err) {
        log.warn(`[Crawler] Source "${source.name}" failed:`, String(err))
        results.push([])
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, activeSources.length) }, () => worker())
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
 * 测试爬虫源是否可用
 */
export async function testCrawlerSource(config: CrawlerSourceConfig, testKeyword: string = '测试'): Promise<{
  success: boolean
  message: string
  resultCount?: number
}> {
  try {
    const results = await searchCrawlerSource(config, testKeyword)
    return {
      success: true,
      message: `成功获取 ${results.length} 条结果`,
      resultCount: results.length,
    }
  } catch (err) {
    return {
      success: false,
      message: `测试失败: ${String(err)}`,
    }
  }
}
