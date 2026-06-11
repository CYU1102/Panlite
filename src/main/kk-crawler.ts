import { net } from 'electron'
import type { SearchResultItem } from '../shared/types'
import log from 'electron-log'

/**
 * KK类型搜索爬虫
 * 参考 xinyue-search 的 handleKk 实现
 * 使用 kkkba.com 的自定义接口
 */

// ── 网盘链接正则（与xinyue-search完全一致） ──

const PAN_PATTERNS: Record<string, RegExp> = {
  quark: /https:\/\/pan\.quark\.cn\/[^\s]+/,
  baidu: /https:\/\/pan\.baidu\.com\/[^\s]+/,
}

// ── KK API 配置 ──

const KK_API_BASE = 'https://m.kkkba.com'

// KK接口列表（与xinyue-search一致）
const KK_API_LIST: Record<number, string> = {
  1: '/v/api/getJuzi',
  2: '/v/api/search',
  // 3: '/v/api/getXiaoyu',
  // 4: '/v/api/getDJ',
  // 5: '/v/api/getKK',
}

// ── 网络请求 ──

async function fetchJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET'
    const timeout = options.timeout || 5000

    const request = net.request({ method, url })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        request.setHeader(k, v)
      }
    }

    if (options.body) {
      request.setHeader('Content-Type', 'application/json')
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
        try {
          resolve(JSON.parse(responseData))
        } catch {
          resolve(null)
        }
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

// ── KK搜索配置接口 ──

export interface KkSearchConfig {
  name: string
  platform: string     // 'quark' 或 'baidu'
  apiType?: number     // 0=全部, 1=getJuzi, 2=search
  maxCount?: number
  weight?: number
  status?: number
}

// ── 核心搜索函数 ──

/**
 * 获取KK API Token
 * 参考 xinyue-search 的 handleKk 实现
 */
async function getKkToken(): Promise<string | null> {
  try {
    const result = await fetchJson(`${KK_API_BASE}/v/api/getToken`, { timeout: 5000 })
    return result?.token || null
  } catch (err) {
    log.warn('[KK Crawler] Failed to get token:', String(err))
    return null
  }
}

/**
 * 执行KK类型搜索
 * 与 xinyue-search 的 handleKk 逻辑完全一致
 */
export async function searchKk(config: KkSearchConfig, keyword: string): Promise<SearchResultItem[]> {
  try {
    const type = config.platform === 'quark' ? 0 : config.platform === 'baidu' ? 2 : -1
    const maxCount = config.maxCount || 20
    const apiType = config.apiType || 0

    // 检查平台支持（与xinyue-search一致，只支持夸克和百度）
    if (!PAN_PATTERNS[config.platform]) {
      log.warn(`[KK Crawler] Unsupported platform: ${config.platform}`)
      return []
    }

    const pattern = PAN_PATTERNS[config.platform]

    // 获取Token
    const token = await getKkToken()
    if (!token) {
      log.warn('[KK Crawler] Failed to get token')
      return []
    }

    // 确定要调用的接口列表（与xinyue-search一致）
    let apiList: string[] = []
    if (apiType === 0) {
      // 全部接口
      apiList = Object.values(KK_API_LIST)
    } else if (KK_API_LIST[apiType]) {
      // 指定某个接口
      apiList = [KK_API_LIST[apiType]]
    } else {
      log.warn(`[KK Crawler] Invalid apiType: ${apiType}`)
      return []
    }

    log.info(`[KK Crawler] Searching "${keyword}" with ${apiList.length} APIs`)

    const results: SearchResultItem[] = []

    // 请求体（与xinyue-search一致）
    const requestData = {
      name: keyword,
      token: token,
    }

    for (const apiUrl of apiList) {
      if (results.length >= maxCount) break

      try {
        const response = await fetchJson(`${KK_API_BASE}${apiUrl}`, {
          method: 'POST',
          body: JSON.stringify(requestData),
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        })

        if (!response?.list || !Array.isArray(response.list)) {
          continue
        }

        for (const item of response.list) {
          if (results.length >= maxCount) break

          const answer = item.answer || ''
          const match = answer.match(pattern)

          if (match) {
            let link = match[0]

            // 提取提取码（与xinyue-search完全一致）
            const codeMatch = answer.match(/提取码[:：]?\s*([a-zA-Z0-9]{4})/)
            if (codeMatch) {
              link += '?pwd=' + codeMatch[1]
            }

            // 提取标题（与xinyue-search完全一致）
            // preg_replace('/\s*[\(（]?(夸克|百度)?[\)）]?\s*/u', '', $value['answer'] ?? '')
            const titleText = answer
              .replace(/\s*[(\(（]?(夸克|百度)?[)）]?\s*/gu, '')
              .trim()

            results.push({
              title: titleText || '未知资源',
              url: link,
              password: codeMatch?.[1],
              platform: config.platform,
              sourceName: `KK: ${config.name}`,
            })
          }
        }
      } catch (err) {
        log.warn(`[KK Crawler] API "${apiUrl}" failed:`, String(err))
        continue
      }
    }

    log.info(`[KK Crawler] Found ${results.length} results`)
    return results

  } catch (err) {
    log.error('[KK Crawler] Error:', String(err))
    return []
  }
}

/**
 * 并发搜索多个KK配置
 */
export async function searchKkSources(
  configs: KkSearchConfig[],
  keyword: string,
  platform?: string
): Promise<SearchResultItem[]> {
  // 过滤启用的配置和平台
  const activeConfigs = configs.filter(c => {
    if (c.status === 0) return false
    if (platform && c.platform !== platform) return false
    return true
  })

  if (activeConfigs.length === 0) return []

  // 并发搜索（最多3个并发）
  const MAX_CONCURRENT = 3
  const results: SearchResultItem[][] = []
  let index = 0

  async function worker() {
    while (index < activeConfigs.length) {
      const config = activeConfigs[index++]
      try {
        const result = await searchKk(config, keyword)
        results.push(result)
      } catch (err) {
        log.warn(`[KK Crawler] Config "${config.name}" failed:`, String(err))
        results.push([])
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, activeConfigs.length) }, () => worker())
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
