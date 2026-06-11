/**
 * 预加载脚本：从页面中提取网盘链接
 * 注入到 webview 中使用
 */

const { ipcRenderer } = require('electron')

// 网盘链接正则
const PAN_PATTERNS = [
  { regex: /https:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+(\?pwd=[a-zA-Z0-9]+)?/g, platform: 'quark' },
  { regex: /https:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/g, platform: 'baidu' },
  { regex: /https:\/\/drive\.uc\.cn\/s\/[a-zA-Z0-9]+(\?pwd=[a-zA-Z0-9]+)?/g, platform: 'uc' },
  { regex: /https:\/\/pan\.xunlei\.com\/s\/[a-zA-Z0-9_-]+(\?pwd=[a-zA-Z0-9]+)?/g, platform: 'xunlei' },
]

function extractLinks() {
  const results = []
  const seen = new Set()

  // 从所有 <a> 标签提取
  const links = document.querySelectorAll('a[href]')
  for (const a of links) {
    const href = a.href || ''
    let matched = false
    for (const { regex } of PAN_PATTERNS) {
      regex.lastIndex = 0
      if (regex.test(href)) {
        matched = true
        break
      }
    }
    if (!matched) continue

    const key = href.split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)

    // 获取标题
    let title = (a.textContent || '').trim()
    if (!title || title.length < 2 || title.length > 200) {
      const parent = a.closest('.item, .result, .card, li, article, [class*="item"], [class*="result"]')
      if (parent) {
        const titleEl = parent.querySelector('h1, h2, h3, h4, h5, .title, [class*="title"], [class*="name"]')
        if (titleEl) title = (titleEl.textContent || '').trim()
      }
    }

    // 提取提取码
    let password = undefined
    const parentText = (a.parentElement || a).textContent || ''
    const pwdMatch = parentText.match(/(?:提取码|密码|pwd|code)[:\s："' ]*([a-zA-Z0-9]{4})/i)
    if (pwdMatch) password = pwdMatch[1]

    let finalUrl = href
    if (password && !href.includes('?pwd=')) {
      finalUrl = href + '?pwd=' + password
    }

    results.push({ url: finalUrl, title: title || '未知资源', password })
  }

  return results
}

// 监听主进程发来的消息
ipcRenderer.on('extract-links', () => {
  const links = extractLinks()
  // 通过 console.message 发送回主进程
  console.log(JSON.stringify({ type: 'extracted-links', links }))
})
