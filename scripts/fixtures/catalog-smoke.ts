import { app, BrowserWindow, session } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, initDatabase, insertAccount, setSetting } from '../../src/main/db'
import { registerIpcHandlers, cleanupIpcResources } from '../../src/main/ipc'
import { getCatalogService } from '../../src/main/catalog-runtime'
import { getAdapter } from '../../src/adapters/registry'
import { encryptCredential } from '../../src/main/crypto'
import type { FileItem } from '../../src/shared/types'

const profile = process.env.PANLITE_CATALOG_SMOKE_PROFILE!
const output = process.env.PANLITE_CATALOG_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('Isolated catalog smoke paths are required')
app.setPath('userData', profile)
app.disableHardwareAcceleration()

async function waitFor(win: BrowserWindow, predicate: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await win.webContents.executeJavaScript(predicate)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  writeFileSync(join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  const detail = await win.webContents.executeJavaScript('document.body.innerText')
  throw new Error(`Renderer state did not appear: ${predicate}\n${detail}`)
}

app.whenReady().then(async () => {
  const errors: string[] = []
  const network: string[] = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    network.push(new URL(details.url).origin)
    callback({ cancel: true })
  })
  initDatabase()
  for (const [accountId, platform, nickname] of [['catalog-webdav', 'webdav', '工作资料'], ['catalog-quark', 'quark', '个人素材']] as const) {
    insertAccount({ id: accountId, platform, nickname, login_type: 'password', encrypted_credential: encryptCredential('{}'),
      user_agent: null, status: 'active', bind_machine: 1, created_at: Date.now(), updated_at: Date.now(), last_check_at: null })
    const stamp = Date.now() - 3600_000
    getAdapter(platform).listFiles = async (account, parentId) => {
      const file = (id: string, name: string, isDir = false): FileItem => ({ id, name, parentId, isDir,
        size: isDir ? 0 : 1_024_000, createdAt: stamp, updatedAt: stamp, accountId: account.id, platform: account.platform })
      const files = parentId === '0'
        ? [file('projects', '项目素材', true), ...Array.from({ length: 60 }, (_, index) => file(`report-${index}`, `${index % 2 ? '设计参考' : '季度报告'}-${String(index + 1).padStart(3, '0')}.pdf`))]
        : [file('nested', '合同归档.pdf'), file('photo', '封面素材.png')]
      return { files, parentId, hasMore: false }
    }
    getAdapter(platform).getQuota = async () => ({ used: 5 * 1024 ** 3, total: 100 * 1024 ** 3 })
  }
  registerIpcHandlers()
  const catalog = getCatalogService()
  for (const accountId of ['catalog-webdav', 'catalog-quark']) {
    const added = await catalog.addScope({ accountId, rootId: '0', rootPath: '/' })
    if (!added.success) throw new Error(added.error)
    await catalog.startScan(added.scope.id)
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const scopes = await catalog.listScopes()
    if (scopes.success && scopes.scopes.every(scope => scope.status === 'completed')) break
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  await catalog.setTags({ accountId: 'catalog-webdav', fileId: 'nested', tags: ['合同', '项目交付'] })
  await catalog.setFavorite({ accountId: 'catalog-webdav', fileId: 'nested', favorite: true })
  const collection = await catalog.saveCollection({ name: '正在进行的项目' })
  if (!collection.success) throw new Error(collection.error)
  await catalog.setEntryCollections({ accountId: 'catalog-webdav', fileId: 'nested', collectionIds: [collection.collection.id] })
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true,
  } })
  win.removeMenu()
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const screenshots: Array<{ theme: string; width: number; file: string; geometry: unknown }> = []
  try {
    for (const [theme, width] of [['light', 1280], ['dark', 960]] as const) {
      setSetting('theme', theme)
      win.setSize(width, 900)
      await win.loadURL('about:blank')
      await win.loadFile(join(__dirname, '../../renderer/index.html'), { hash: '/file-catalog' })
      await waitFor(win, 'document.querySelectorAll(".catalog-page tbody tr").length > 0')
      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('input[aria-label="文件名称"]'); input.value='合同'; input.dispatchEvent(new Event('input',{bubbles:true})); input.closest('form').requestSubmit();
      })()`)
      await waitFor(win, 'document.querySelectorAll(".catalog-page tbody tr").length === 2')
      if (theme === 'dark') {
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='筛选').click()`)
        await waitFor(win, '!!document.querySelector(".filter-grid")')
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const page=document.querySelector('.catalog-page'); const rect=page.getBoundingClientRect();
        return {width:innerWidth,bodyOverflow:document.body.scrollWidth>innerWidth,pageOverflow:page.scrollWidth>page.clientWidth+1,
          pageColor:getComputedStyle(page).backgroundColor, rootDark:document.documentElement.classList.contains('dark'),
          pageRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, rows:document.querySelectorAll('tbody tr').length};
      })()`)
      if (geometry.bodyOverflow || geometry.pageOverflow || geometry.rootDark !== (theme === 'dark')) throw new Error(`Invalid catalog layout: ${JSON.stringify(geometry)}`)
      const file = `catalog-${theme}-${width}.png`
      writeFileSync(join(output, file), (await win.webContents.capturePage()).toPNG())
      screenshots.push({ theme, width, file, geometry })
    }
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('tbody tr button')).find(node=>node.textContent.includes('核对并定位')).click()`)
    await waitFor(win, '!!document.querySelector(".file-manager") && document.body.textContent.includes("已在线确认")')
    writeFileSync(join(output, 'catalog-location.png'), (await win.webContents.capturePage()).toPNG())
    const result = await catalog.search({ keyword: '合同' })
    if (!result.success || result.total !== 2) throw new Error('Unexpected runtime catalog result')
    if (network.length) throw new Error(`Unexpected outbound requests were blocked: ${network.join(',')}`)
    if (errors.length) throw new Error(`Renderer errors: ${errors.join('\n')}`)
    writeFileSync(join(output, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), electron: process.versions.electron, sqlite: getDb().prepare('select sqlite_version() version').get(),
      scenario: 'Isolated profile; real renderer/preload/IPC/catalog/SQLite; synthetic adapter directories; all external network blocked',
      screenshots, liveLocationConfirmed: true, externalRequests: network.length, rendererErrors: errors,
    }, null, 2))
    console.log('Catalog Electron runtime and live source navigation verified')
  } finally {
    cleanupIpcResources()
    win.destroy()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
