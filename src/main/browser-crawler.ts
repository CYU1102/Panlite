import { BrowserWindow } from 'electron'
import type { SearchResultItem } from '../shared/types'
import log from 'electron-log'

/**
 * 浏览器爬虫引擎
 * 使用隐藏的BrowserWindow加载搜索页面，从DOM中提取网盘链接和标题
 */

// ── 网盘链接正则 ──

const ALL_PAN_PATTERN = /https:\/\/(?:pan\.quark\.cn\/s\/[a-zA-Z0-9]+|pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?|drive\.uc\.cn\/s\/[a-zA-Z0-9]+|pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?)/g

// ── 从DOM中提取搜索结果（带标题和链接） ──

const EXTRACT_SCRIPT = `
(function() {
  const results = [];
  const seen = new Set();

  // 网盘链接正则
  const panRegex = /https:\\/\\/(?:pan\\.quark\\.cn\\/s\\/[a-zA-Z0-9]+|pan\\.baidu\\.com\\/s\\/[a-zA-Z0-9_-]+(\\?pwd=[a-zA-Z0-9]+)?|drive\\.uc\\.cn\\/s\\/[a-zA-Z0-9]+|pan\\.xunlei\\.com\\/s\\/[a-zA-Z0-9_-]+(\\?pwd=[a-zA-Z0-9]+)?)/g;

  // 方法1: 从所有 <a> 标签提取
  const links = document.querySelectorAll('a[href]');
  for (const a of links) {
    const href = a.href || '';
    if (!panRegex.test(href)) continue;
    panRegex.lastIndex = 0;

    const key = href.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);

    // 获取标题: 优先从链接文本，其次从父元素
    let title = (a.textContent || '').trim();
    let date = '';
    if (!title || title.length < 2 || title.length > 200) {
      // 尝试从父元素获取标题
      const parent = a.closest('.item, .result, .card, .list-group-item, li, article, .search-item, [class*="item"], [class*="result"]');
      if (parent) {
        const titleEl = parent.querySelector('h1, h2, h3, h4, h5, .title, [class*="title"], [class*="name"]');
        if (titleEl) title = (titleEl.textContent || '').trim();
        // 尝试获取日期
        const dateEl = parent.querySelector('.date, .time, [class*="date"], [class*="time"], time');
        if (dateEl) date = (dateEl.textContent || '').trim();
      }
    }

    // 提取提取码
    let password = undefined;
    const parentText = (a.parentElement || a).textContent || '';
    const pwdMatch = parentText.match(/(?:提取码|密码|pwd|code)[:\\s："' ]*([a-zA-Z0-9]{4})/i);
    if (pwdMatch) password = pwdMatch[1];

    let finalUrl = href;
    if (password && !href.includes('?pwd=')) {
      finalUrl = href + '?pwd=' + password;
    }

    results.push({ url: finalUrl, title: title || '', password: password, date: date });
  }

  // 方法2: 从文本节点中提取（处理非链接形式的网盘URL）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent || '';
    let m;
    panRegex.lastIndex = 0;
    while ((m = panRegex.exec(text)) !== null) {
      const url = m[0];
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);

      // 从周围元素获取标题
      let title = '';
      const parent = walker.currentNode.parentElement;
      if (parent) {
        const prev = parent.previousElementSibling;
        if (prev) title = (prev.textContent || '').trim().substring(0, 100);
        if (!title) title = (parent.textContent || '').replace(url, '').trim().substring(0, 100);
      }

      // 提取提取码
      let password = undefined;
      const after = text.substring(m.index, m.index + 300);
      const pwdMatch = after.match(/(?:提取码|密码|pwd|code)[:\\s："' ]*([a-zA-Z0-9]{4})/i);
      if (pwdMatch) password = pwdMatch[1];

      let finalUrl = url;
      if (password && !url.includes('?pwd=')) {
        finalUrl = url + '?pwd=' + password;
      }

      results.push({ url: finalUrl, title: title, password: password });
    }
  }

  return JSON.stringify(results);
})()
`

// ── 浏览器爬虫核心 ──

interface BrowserCrawlResult {
  url: string
  success: boolean
  results: SearchResultItem[]
  error?: string
}

async function crawlSite(
  baseUrl: string,
  keyword: string,
  platform: string,
  sourceName: string,
  timeoutMs: number = 30000
): Promise<BrowserCrawlResult> {
  let win: BrowserWindow | null = null

  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        javascript: true,
        images: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    // 捕获 XHR 响应体
    const capturedBodies: string[] = []

    win.webContents.session.webRequest.onCompleted(
      { urls: ['*://*/*'] },
      async (details) => {
        if (details.resourceType === 'xhr' && details.statusCode >= 200 && details.statusCode < 400) {
          try {
            const body = await win!.webContents.executeJavaScript(`
              (function() {
                return new Promise((resolve) => {
                  const xhr = new XMLHttpRequest();
                  xhr.open('GET', '${details.url}', true);
                  xhr.onload = function() { resolve(xhr.responseText || '') };
                  xhr.onerror = function() { resolve('') };
                  xhr.send();
                });
              })()
            `).catch(() => '')
            if (body) capturedBodies.push(body)
          } catch {}
        }
      }
    )

    const timeoutPromise = new Promise<BrowserCrawlResult>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    })

    const crawlPromise = new Promise<BrowserCrawlResult>(async (resolve) => {
      try {
        // 构建搜索URL
        let searchUrl = baseUrl
        if (baseUrl.includes('{keyword}')) {
          searchUrl = baseUrl.replace(/\{keyword\}/g, encodeURIComponent(keyword))
        } else if (!baseUrl.includes('?')) {
          searchUrl = baseUrl.replace(/\/+$/, '') + '/search?keyword=' + encodeURIComponent(keyword)
        } else if (baseUrl.includes('?')) {
          searchUrl = baseUrl + '&keyword=' + encodeURIComponent(keyword)
        }

        log.info(`[Browser Crawler] Loading: ${searchUrl}`)

        await win!.loadURL(searchUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })

        // 等待页面加载完成
        await new Promise(r => setTimeout(r, 3000))

        // 从DOM提取结果
        let results: SearchResultItem[] = []
        try {
          const jsonStr = await win!.webContents.executeJavaScript(EXTRACT_SCRIPT)
          const extracted = JSON.parse(jsonStr)
          results = extracted
            .filter((item: any) => item.url && item.title)
            .map((item: any) => ({
              title: item.title.substring(0, 200),
              url: item.url,
              password: item.password,
              platform,
              sourceName,
            }))
        } catch (err) {
          log.warn(`[Browser Crawler] DOM extraction failed:`, err)
        }

        // 从XHR响应体中提取
        for (const body of capturedBodies) {
          try {
            const xhrResults = JSON.parse(body)
            // 递归搜索JSON中的网盘链接
            const findLinks = (obj: any): void => {
              if (!obj) return
              if (typeof obj === 'string') {
                const matches = obj.match(ALL_PAN_PATTERN) || []
                for (const url of matches) {
                  const key = url.split('?')[0]
                  if (!results.find(r => r.url.split('?')[0] === key)) {
                    results.push({ title: '资源', url, platform, sourceName })
                  }
                }
              } else if (Array.isArray(obj)) {
                obj.forEach(findLinks)
              } else if (typeof obj === 'object') {
                // 检查是否有title+url组合
                if (obj.title && obj.url && typeof obj.url === 'string' && obj.url.match(ALL_PAN_PATTERN)) {
                  const key = obj.url.split('?')[0]
                  if (!results.find(r => r.url.split('?')[0] === key)) {
                    results.push({ title: obj.title, url: obj.url, password: obj.password, platform, sourceName })
                  }
                }
                Object.values(obj).forEach(findLinks)
              }
            }
            findLinks(xhrResults)
          } catch {}
        }

        // 按日期排序（最新的在前）
        results.sort((a, b) => {
          if (a.date && b.date) {
            const dateA = new Date(a.date).getTime()
            const dateB = new Date(b.date).getTime()
            if (!isNaN(dateA) && !isNaN(dateB)) return dateB - dateA
          }
          return 0
        })

        resolve({ url: baseUrl, success: true, results })
      } catch (err) {
        resolve({ url: baseUrl, success: false, results: [], error: String(err) })
      }
    })

    return await Promise.race([crawlPromise, timeoutPromise])

  } catch (err) {
    return { url: baseUrl, success: false, results: [], error: String(err) }
  } finally {
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
  }
}

// ── 公开接口 ──

export interface BrowserCrawlerSource {
  name: string
  url: string
  platform: string
  maxCount?: number
}

export async function searchWithBrowser(
  source: BrowserCrawlerSource,
  keyword: string
): Promise<SearchResultItem[]> {
  log.info(`[Browser Crawler] Searching "${source.name}" for "${keyword}"`)

  const result = await crawlSite(source.url, keyword, source.platform, source.name, 15000)

  if (result.success && result.results.length > 0) {
    log.info(`[Browser Crawler] Found ${result.results.length} results from "${source.name}"`)
    return result.results
  }

  if (result.error) {
    log.warn(`[Browser Crawler] "${source.name}" error: ${result.error}`)
  } else {
    log.info(`[Browser Crawler] No results from "${source.name}"`)
  }
  return []
}
