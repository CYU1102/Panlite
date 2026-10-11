const { app, BrowserWindow, protocol } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const output = process.env.PANLITE_UI_OUTPUT
const url = process.env.PANLITE_UI_URL
app.setPath('userData', process.env.PANLITE_UI_PROFILE)
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'panlite-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
const report = { syntheticDataOnly: true, hiddenWindows: true, noDesktopInput: true, blockedRequests: [], errors: [], console: [], captures: [] }
const aiDark = process.env.PANLITE_UI_AI_DARK === '1'
if (aiDark) {
  const previous = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
  report.captures = previous.captures.filter(capture => !capture.name.includes('-dark-ai-'))
  report.blockedRequests = previous.blockedRequests
  report.supplementalValidation = [...(previous.supplementalValidation || []), { scope: 'All dark AI views at every matrix size/zoom', sourceChange: 'AiWorkspace.vue composer primary text color set to white', date: new Date().toISOString() }]
}
let window
const js = code => window.webContents.executeJavaScript(code)
async function until(expression) {
  for (let attempt = 0; attempt < 450; attempt++) { if (await js(expression)) return; await wait(100) }
  throw new Error(`UI condition timed out: ${expression}`)
}
async function click(selector, text) {
  const found = await js(`(()=>{const item=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node=>${text ? `node.textContent.trim()===${JSON.stringify(text)}` : 'node.getBoundingClientRect().width>0'});if(!item)return false;item.click();return true})()`)
  if (!found) throw new Error(`Missing control: ${selector} ${text || ''}`)
  await wait(220)
}
async function capture(name, scenario) {
  await wait(250)
  const metrics = await js(`(()=>{const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();if(!r.width||!r.height)return null;return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,mainContent:rect(document.querySelector('#main-content')),sidebar:rect(document.querySelector('.sidebar')),chat:rect(document.querySelector('.chat-panel')),composer:rect(document.querySelector('.composer')),sources:rect(document.querySelector('.source-panel, .ai-source-drawer')),topbar:rect(document.querySelector('.topbar')),topbarActions:rect(document.querySelector('.topbar-actions')),previewDialog:rect(document.querySelector('.file-preview-dialog')),previewClose:rect(document.querySelector('.file-preview-dialog .dialog-footer button')),errors:window.__UI_VISUAL_ERRORS||[]}})()`)
  const image = await window.webContents.capturePage()
  const file = `${name}.png`
  writeFileSync(join(output, file), image.toPNG())
  report.captures.push({ name, file, ...scenario, imageSize: image.getSize(), metrics })
  console.log(`Captured ${name}`)
}
app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true })
  protocol.handle('panlite-preview', () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#f6f8fc"/><rect x="110" y="120" width="310" height="180" rx="18" fill="#eaf2ff" stroke="#3478f6"/><rect x="770" y="400" width="310" height="180" rx="18" fill="white" stroke="#3478f6"/><path d="M420 210H620V490H770" fill="none" stroke="#3478f6" stroke-width="5"/><text x="170" y="225" font-size="28" fill="#1f2937">Cloud files</text><text x="815" y="505" font-size="28" fill="#1f2937">Documents</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }))
  window = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { preload: join(__dirname, 'ui-visual-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(new URL(url).origin) || details.url.startsWith('panlite-preview:') || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url.startsWith('devtools:')
    if (!allowed) report.blockedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('console-message', (_event, level, message) => report.console.push(typeof level === 'object' ? level : { level, message }))
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push(details))
  const quick = process.env.PANLITE_UI_QUICK === '1'
  const scenarios = quick ? [{ width: 1280, height: 720, zoom: 1 }] : [{ width: 1280, height: 720, zoom: 1 }, { width: 1440, height: 900, zoom: 1 }, { width: 1920, height: 1080, zoom: 1 }, { width: 1280, height: 720, zoom: 1.25 }, { width: 1280, height: 720, zoom: 1.5 }]
  for (const size of scenarios) for (const theme of quick ? ['light'] : aiDark ? ['dark'] : ['light', 'dark']) {
    window.setContentSize(size.width, size.height)
    window.webContents.setZoomFactor(size.zoom)
    await window.loadURL(url)
    await until('Boolean(window.__UI_VISUAL_READY)')
    await js(`window.__UI_VISUAL_CONTROL.theme(${JSON.stringify(theme)})`)
    const scenario = { ...size, theme }, prefix = `${size.width}x${size.height}-z${size.zoom}-${theme}`
    for (const route of aiDark ? [] : ['/files', '/accounts', '/settings']) {
      await js(`window.__UI_VISUAL_CONTROL.route(${JSON.stringify(route)})`)
      await until('Boolean(document.querySelector("#main-content > *"))')
      await capture(`${prefix}-${route.slice(1)}`, scenario)
      if (route === '/files') {
        await click('.file-name-open', '架构示意图.png')
        await until('Boolean(document.querySelector(".image-stage img")?.complete)')
        await capture(`${prefix}-file-preview-image`, scenario)
        await click('.preview-expand')
        await capture(`${prefix}-file-preview-expanded`, scenario)
        await click('.dialog-footer button', '关闭')
        await wait(350)
      }
    }
    await js('window.__UI_VISUAL_CONTROL.route("/ai-workspace")')
    await until('Boolean(document.querySelector(".workspace-tabs"))')
    await capture(`${prefix}-ai-overview`, scenario)
    await click('.workspace-tabs button', '文档问答')
    await until('Boolean(document.querySelector(".composer"))')
    await capture(`${prefix}-ai-ask`, scenario)
    if (!await js('Boolean(document.querySelector(".source-panel, .ai-source-drawer"))')) await click('.chat-tools button', '文档与来源')
    await capture(`${prefix}-ai-sources`, scenario)
    if (await js('Boolean(document.querySelector(".citations summary"))')) {
      await click('.citations summary')
      await until('Boolean(document.querySelector(".source-content .text"))')
      await capture(`${prefix}-ai-citation`, scenario)
    }
    await click('[aria-label="关闭文档与来源"]')
    await wait(500)
    await click('.history-toggle')
    await capture(`${prefix}-ai-history-toggle`, scenario)
    await click('.workspace-tabs button', '文档库6')
    await capture(`${prefix}-ai-documents`, scenario)
    await click('.workspace-tabs button', 'AI 任务4')
    await capture(`${prefix}-ai-tasks`, scenario)
  }
  if (!quick && !aiDark) for (const theme of ['light', 'dark']) {
    window.setContentSize(1440, 900)
    window.webContents.setZoomFactor(1)
    await window.loadURL(url)
    await until('Boolean(window.__UI_VISUAL_READY)')
    await js(`window.__UI_VISUAL_CONTROL.theme(${JSON.stringify(theme)})`)
    for (const route of ['/tasks', '/global-search', '/resource-search', '/share-links']) {
      await js(`window.__UI_VISUAL_CONTROL.route(${JSON.stringify(route)})`)
      await wait(500)
      await capture(`1440x900-z1-${theme}-${route.slice(1)}`, { width: 1440, height: 900, zoom: 1, theme })
    }
  }
  report.layoutIssues = report.captures.flatMap(item => {
    const issues = []
    if (item.metrics.documentWidth > item.metrics.viewport.width + 1) issues.push({ capture: item.name, issue: 'document-horizontal-overflow' })
    if (item.metrics.composer && item.metrics.composer.bottom > item.metrics.mainContent.bottom + 1) issues.push({ capture: item.name, issue: 'composer-below-main-content' })
    if (item.metrics.topbarActions && item.metrics.topbarActions.right > item.metrics.viewport.width + 1) issues.push({ capture: item.name, issue: 'topbar-actions-outside-viewport' })
    if (item.metrics.previewClose && item.metrics.previewClose.bottom > item.metrics.viewport.height + 1) issues.push({ capture: item.name, issue: 'preview-close-below-viewport' })
    return issues
  })
  report.network = { blockedLocalDevSockets: report.blockedRequests.filter(value => { try { return new URL(value).hostname === '127.0.0.1' } catch { return false } }).length, blockedRemoteRequests: report.blockedRequests.filter(value => { try { return new URL(value).hostname !== '127.0.0.1' } catch { return true } }) }
  report.errors.push(...report.captures.flatMap(item => item.metrics.errors.map(error => ({ capture: item.name, error }))))
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  window.destroy()
  app.exit(report.errors.length || report.layoutIssues.length ? 1 : 0)
}).catch(error => {
  report.errors.push({ message: error.message, stack: error.stack })
  Promise.resolve(window?.webContents.executeJavaScript('({errors:window.__UI_VISUAL_ERRORS,html:document.body.innerText,ready:window.__UI_VISUAL_READY})')).then(diagnostic => {
    report.diagnostic = diagnostic
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.error(error)
    window?.destroy()
    app.exit(1)
  }).catch(() => { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); window?.destroy(); app.exit(1) })
})
