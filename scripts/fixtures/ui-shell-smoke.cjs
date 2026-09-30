const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const output = process.env.PANLITE_UI_SMOKE_OUTPUT
const profile = process.env.PANLITE_UI_SMOKE_PROFILE
const renderer = process.env.PANLITE_UI_SMOKE_RENDERER
if (!output || !profile || !renderer) throw new Error('Isolated UI smoke paths are required')
app.setPath('userData', profile)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-shell-smoke-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  const errors = []
  win.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message)
  })
  const evaluate = source => win.webContents.executeJavaScript(source)
  const waitFor = async (condition, label) => {
    const until = Date.now() + 15000
    while (Date.now() < until) {
      if (await evaluate(condition)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out: ${label}; console=${errors.join('|')}`)
  }
  const capture = async name => {
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG())
  }

  try {
    await win.loadFile(path.join(renderer, 'index.html'), { hash: '/accounts' })
    await waitFor("document.querySelectorAll('.account-card').length === 2", 'fixture accounts')
    await capture('accounts-light.png')
    await evaluate("document.documentElement.classList.add('dark')")
    await capture('accounts-dark.png')
    await evaluate("document.documentElement.classList.remove('dark'); location.hash = '#/files'")
    await waitFor("Boolean(document.querySelector('.account-select-control .el-select__wrapper'))", 'file toolbar')
    await evaluate("document.querySelector('.account-select-control .el-select__wrapper').click()")
    await waitFor("[...document.querySelectorAll('.el-select-dropdown__item')].some(item => item.textContent.includes('项目资料账号'))", 'account option')
    await evaluate("[...document.querySelectorAll('.el-select-dropdown__item')].find(item => item.textContent.includes('项目资料账号')).click()")
    await waitFor("[...document.querySelectorAll('.file-name')].some(item => item.textContent.includes('发布演示视频'))", 'fixture files')
    await evaluate("document.querySelector('.action-more').focus()")
    await waitFor("getComputedStyle(document.querySelector('.action-btns .action-btn:not(.action-more)')).opacity === '1'", 'keyboard file actions')
    await evaluate("document.querySelector('.action-more').blur()")
    await capture('files-light.png')
    await evaluate("document.documentElement.classList.add('dark')")
    await capture('files-dark.png')
    await evaluate("document.documentElement.classList.remove('dark')")
    win.setSize(1280, 800)
    await waitFor('document.documentElement.scrollWidth <= innerWidth', 'compact file width')
    await capture('files-compact.png')
    await evaluate("location.hash = '#/accounts'")
    await waitFor("document.querySelectorAll('.account-card').length === 2", 'compact accounts')
    await waitFor('document.documentElement.scrollWidth <= innerWidth', 'compact account width')
    await capture('accounts-compact.png')
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: errors.length === 0, errors, screens: 6 }, null, 2))
    if (errors.length) throw new Error(errors.join('\n'))
  } finally {
    win.destroy()
    app.quit()
  }
}).catch(error => { console.error(error); app.exit(1) })
