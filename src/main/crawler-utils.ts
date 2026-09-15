import { net } from 'electron'
import { getSearchSignal } from './search-runtime'

/**
 * 通用网页爬虫工具函数
 * 从 crawler-engine.ts 和 tg-crawler.ts 中提取的共享代码
 */

export interface SearchRequestOptions { method?: string; headers?: Record<string, string>; body?: string; timeout?: number }

/** Shared transport for HTML, configured APIs and KK; binds cancellation to the active search. */
export async function fetchSearchText(url: string, options: SearchRequestOptions = {}): Promise<string> {
  const signal = getSearchSignal()
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = net.request({ method: options.method || 'GET', url })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')
    for (const [key, value] of Object.entries(options.headers || {})) request.setHeader(key, value)
    const chunks: Buffer[] = []
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => { fail(signal?.reason || new Error('Search cancelled')); request.abort() }
    const timer = setTimeout(() => { fail(new Error('Request timeout')); request.abort() }, options.timeout || 15000)
    signal?.addEventListener('abort', abort, { once: true })
    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 400) {
        fail(new Error(`HTTP ${response.statusCode}`)); request.abort(); return
      }
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')) })
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('Response aborted')))
    })
    request.on('error', fail)
    request.on('abort', () => fail(signal?.reason || new Error('Request aborted')))
    if (options.body) {
      request.setHeader('Content-Length', String(Buffer.byteLength(options.body)))
      request.write(options.body)
    }
    if (signal?.aborted) { abort(); return }
    request.end()
  })
}

/** 获取网页 HTML 内容 */
export function fetchHtml(url: string, timeout = 15000): Promise<string> {
  return fetchSearchText(url, { timeout, headers: {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  } })
}

/** 去除HTML标签 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

/** 解码HTML实体 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
}
