import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import log from 'electron-log'

/**
 * 内嵌浏览器模块
 * 提供一个可交互的浏览器窗口，用户手动搜索
 * 自动从页面中提取网盘链接
 */

// ── 网盘链接正则 ──

const ALL_PAN_PATTERN = /https:\/\/(?:pan\.quark\.cn\/s\/[a-zA-Z0-9]+|pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?|drive\.uc\.cn\/s\/[a-zA-Z0-9]+|pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?)/g

// ── 从HTML中提取网盘链接 ──

function extractLinksFromHtml(html: string): Array<{ url: string; title: string }> {
  const results: Array<{ url: string; title: string }> = []
  const seen = new Set<string>()

  ALL_PAN_PATTERN.lastIndex = 0
  let match
  while ((match = ALL_PAN_PATTERN.exec(html)) !== null) {
    const url = match[0]
    const key = url.split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)

    let title = ''
    const idx = match.index
    if (idx > 0) {
      const before = html.substring(Math.max(0, idx - 300), idx)
      const tMatch = before.match(/(?:名称|标题|title|name)[：:"'\s]*([^<\n"',]{2,60})/i)
        || before.match(/>([^<>]{2,60})<\/[^>]+>\s*$/)
      if (tMatch) title = tMatch[1].replace(/<[^>]+>/g, '').trim()
    }

    let password: string | undefined
    const after = html.substring(idx, idx + 300)
    const pwdMatch = after.match(/(?:提取码|密码|pwd|code)[:\s："']*([a-zA-Z0-9]{4})/i)
    if (pwdMatch) password = pwdMatch[1]

    let finalUrl = url
    if (password && !url.includes('?pwd=')) {
      finalUrl = `${url}?pwd=${password}`
    }

    results.push({ url: finalUrl, title: title || '未知资源' })
  }

  return results
}

// ── 注册IPC处理 ──

export function registerEmbeddedBrowserHandlers(): void {
  // 在内嵌浏览器中打开URL
  ipcMain.handle('embedded-browser:open', async (_event, url: string) => {
    try {
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: '资源搜索浏览器',
        webPreferences: {
          javascript: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      win.loadURL(url, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      })

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 从当前页面提取网盘链接
  ipcMain.handle('embedded-browser:extract', async (_event) => {
    try {
      const windows = BrowserWindow.getAllWindows()
      const links: Array<{ url: string; title: string }> = []
      const seen = new Set<string>()

      for (const win of windows) {
        try {
          const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
          const pageLinks = extractLinksFromHtml(html || '')

          for (const link of pageLinks) {
            const key = link.url.split('?')[0]
            if (!seen.has(key)) {
              seen.add(key)
              links.push(link)
            }
          }
        } catch {}
      }

      return { success: true, links }
    } catch (err) {
      return { success: false, error: String(err), links: [] }
    }
  })

  // 在默认浏览器中打开URL
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
