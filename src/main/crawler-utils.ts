import { net } from 'electron'

/**
 * 通用网页爬虫工具函数
 * 从 crawler-engine.ts 和 tg-crawler.ts 中提取的共享代码
 */

/** 获取网页 HTML 内容 */
export async function fetchHtml(url: string, timeout: number = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
    request.setHeader('Accept-Encoding', 'gzip, deflate')

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
